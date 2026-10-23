/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { debugLog } from './relayConnection';
import { PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, cleanupStalePlaywrightGroups, isNonDebuggableUrl, isPickableUrl, ungroupTabs, uniqueGroupStyle } from './connectedTabGroup';

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
  // When false, the connection runs without a Chrome tab group.
  groupTabs?: boolean;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  connectionId: number;
} | {
  type: 'keepalive';
};

class PlaywrightExtension {
  private _connections = new Map<number, ConnectedTabGroup>();
  private _lastConnectionId = 0;
  private _pendingConnections = new PendingConnections();
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;

  constructor() {
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }

  // A tab that navigates to a page, leaves a client's group or is reloaded
  // after a discard may now be free for a client that has all tabs.
  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void {
    if (changeInfo.url !== undefined || changeInfo.groupId !== undefined || changeInfo.discarded === false)
      void this._pickUpFreeTabs();
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested': {
        const selectorTabId = sender.tab!.id!;
        this._releaseConnectPage(selectorTabId).then(() => {
          this._pendingConnections.create(selectorTabId, message.mcpRelayUrl);
          sendResponse({ success: true });
        });
        return true;
      }
      case 'getTabs':
        this._getTabs(sender.tab?.id).then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        // Token-bypass (no specific pick) falls back to the connect page itself
        // so `ConnectedTabGroup` always has a concrete tab to start from. Both
        // sender.tab and UI-supplied tabs come from chrome.tabs.query / runtime
        // message sender, where `id` is always defined.
        const selectedTab = (message.tab ?? sender.tab!) as chrome.tabs.Tab & { id: number };
        this._connectTab(sender.tab!.id!, selectedTab, message.clientName, message.groupTabs !== false).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._connections].map(([id, group]) => ({
            id,
            clientName: group.clientName,
            connectedTabIds: group.connectedTabIds(),
          })),
        });
        return false;
      case 'disconnect':
        this._connections.get(message.connectionId)?.close('User disconnected');
        sendResponse({ success: true });
        return false;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  private async _connectTab(selectorTabId: number, tab: chrome.tabs.Tab & { id: number }, clientName: string | undefined, groupTabs: boolean): Promise<void> {
    try {
      await this._cleanupPromise;
      await this._releaseTab(selectorTabId);
      if (tab.id !== selectorTabId && this._isTabKept(tab.id))
        throw new Error('This tab is already connected to another client');

      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error('Pending client connection closed');

      const id = ++this._lastConnectionId;
      const taken = [...this._connections.values()].flatMap(group => group.groupStyle ? [group.groupStyle] : []);
      const group = new ConnectedTabGroup(connection, tab, clientName, groupTabs ? uniqueGroupStyle(clientName, taken) : null, tabId => this._pendingConnections.has(tabId));
      group.onwillattach = tabId => this._prepareAttach(group, tabId);
      group.onready = () => {
        if (group.hasAllTabs())
          void this._pickUpFreeTabs();
      };
      group.onclose = () => {
        this._connections.delete(id);
        void this._pickUpFreeTabs();
      };
      this._connections.set(id, group);

      await Promise.all([
        chrome.tabs.update(tab.id, { active: true }),
        chrome.windows.update(tab.windowId, { focused: true }),
      ]).catch(() => {});

      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {});
    } catch (error: any) {
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    }
  }

  // Chrome may create the connect page inside the active client's group.
  private async _releaseConnectPage(tabId: number): Promise<void> {
    await this._releaseTab(tabId);
    await ungroupTabs([tabId]);
  }

  private async _releaseTab(tabId: number): Promise<void> {
    await Promise.all([...this._connections.values()].map(group => group.releaseTab(tabId)));
  }

  // The client with the strongest claim on a tab gets it; on a tie, the
  // client that has the tab keeps it. In practice this lets any client take a
  // tab that a client with all tabs only picked up.
  private async _prepareAttach(group: ConnectedTabGroup, tabId: number): Promise<void> {
    const strength = group.claimStrength(tabId);
    const others = [...this._connections.values()].filter(other => other !== group && other.claimStrength(tabId) > 0);
    if (others.some(other => other.claimStrength(tabId) >= strength))
      throw new Error('This tab is already connected to another client');
    await Promise.all(others.map(other => other.releaseTab(tabId)));
  }

  // Gives each tab that no client has to the oldest client that has all tabs.
  private async _pickUpFreeTabs(): Promise<void> {
    if (![...this._connections.values()].some(group => group.hasAllTabs()))
      return;
    // A tab that a client is opening right now belongs to that client.
    await Promise.all([...this._connections.values()].map(group => group.waitForPendingCreates()));
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const group = [...this._connections.values()].find(group => group.hasAllTabs() && group.isReady());
    if (!group)
      return;
    for (const tab of tabs) {
      if (this._isTabFree(tab))
        group.pickUpTab(tab);
    }
  }

  private _isTabFree(tab: chrome.tabs.Tab): boolean {
    const tabId = tab.id;
    if (tabId === undefined || tab.discarded || !isPickableUrl(tab.url || tab.pendingUrl) || this._pendingConnections.has(tabId))
      return false;
    return [...this._connections.values()].every(group => group.claimStrength(tabId) === 0);
  }

  private async _getTabs(selectorTabId: number | undefined): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => !isNonDebuggableUrl(tab.url) && (tab.id === selectorTabId || !this._isTabKept(tab.id!)));
  }

  // A tab that a client has for more than having all tabs. Other clients
  // cannot select it.
  private _isTabKept(tabId: number): boolean {
    return [...this._connections.values()].some(group => group.claimStrength(tabId) >= 2);
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }
}

new PlaywrightExtension();
