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

import { RelayConnection, debugLog } from './relayConnection';

const PLAYWRIGHT_GROUP_TITLE = 'Playwright';
const PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} · `;
// Green first, so a lone connection keeps the familiar look.
const PLAYWRIGHT_GROUP_COLORS: GroupColor[] = ['green', 'blue', 'purple', 'orange', 'pink', 'cyan', 'yellow', 'red'];
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Playwright client' };

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

// Pages a client with all tabs picks up. Extension pages, such as the connect
// page of another client, are left alone.
export function isPickableUrl(url: string | undefined): boolean {
  return !!url && !isNonDebuggableUrl(url) && !url.startsWith('chrome-extension:');
}

type GroupColor = `${chrome.tabGroups.Color}`;

export type GroupStyle = {
  title: string;
  color: GroupColor;
};

export function uniqueGroupStyle(clientName: string | undefined, taken: readonly GroupStyle[]): GroupStyle {
  const titles = new Set(taken.map(style => style.title));
  const base = PLAYWRIGHT_GROUP_TITLE_PREFIX + (clientName || 'unknown');
  let title = base;
  for (let i = 2; titles.has(title); i++)
    title = `${base} (${i})`;

  const colors = new Set(taken.map(style => style.color));
  const color = PLAYWRIGHT_GROUP_COLORS.find(candidate => !colors.has(candidate)) ?? PLAYWRIGHT_GROUP_COLORS[0];
  return { title, color };
}

// Ungroups any Playwright-titled groups left behind by a prior service worker.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({});
    // The bare title comes from versions that predate per-client groups.
    const stale = groups.filter(g => g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX));
    const tabsPerGroup = await Promise.all(stale.map(g => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map(t => t.id).filter((id): id is number => id !== undefined);
    if (tabIds.length)
      await ungroupTabs(tabIds);
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  }
}

// The tabs of an active RelayConnection. When the connection has a Chrome
// tab group (the default), the group is the single source of truth for which
// tabs the client targets:
//  - User drags a tab in/out → `_onTabGroupChanged` attaches/detaches.
//  - Relay attaches on its own (initial tab, popup, Target.createTarget) →
//    `_onTabAttached` pulls the new tab into the group, whose onUpdated event
//    flows back through `_onTabGroupChanged` for consistency.
// Without a Chrome tab group (`groupStyle === null`) the client has all tabs:
// besides the tabs it attaches itself, it picks up every tab that no other
// client has (see `pickUpTab`). Group changes do not affect its tabs.
// `_groupTabIds` caches group membership from Chrome events (or the tabs the
// client has, in the no-group mode) so hot-path checks in `_onTabUpdated`
// stay synchronous.
export class ConnectedTabGroup {
  readonly clientName: string | undefined;
  // The Chrome tab group style. Null when the connection opted out of grouping
  // and has all tabs instead.
  readonly groupStyle: GroupStyle | null;
  private _connection: RelayConnection;
  private _isTabReserved: (tabId: number) => boolean;
  private _groupId: number | null = null;
  private _groupTabIds: Set<number> = new Set();
  // Tabs the client has only because it has all tabs. Any other client that
  // asks for one of them gets it.
  private _pickedUpTabIds: Set<number> = new Set();
  private _ready = false;
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;

  onclose?: () => void;
  // Fires when the first tab is attached. The MCP client makes the first page
  // it sees its current page, so other tabs are picked up only after that.
  onready?: () => void;
  // Runs before the debugger attaches to a tab; throws to refuse the attach.
  onwillattach?: (tabId: number) => Promise<void>;

  constructor(connection: RelayConnection, selectedTab: chrome.tabs.Tab, clientName: string | undefined, groupStyle: GroupStyle | null, isTabReserved: (tabId: number) => boolean) {
    this.clientName = clientName;
    this.groupStyle = groupStyle;
    this._isTabReserved = isTabReserved;
    this._connection = connection;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    this._connection.onwillattach = async (tabId: number) => await this.onwillattach?.(tabId);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    // Seed the relay with the user-selected tab, then close out the initial
    // handshake. The relay holds Playwright-side CDP traffic until
    // `didInitialize` arrives, so it sees a fully populated tab model by the
    // time it handles `Target.setAutoAttach`.
    this._connection.attachTab(selectedTab);
    this._connection.didInitialize();
  }

  connectedTabIds(): number[] {
    return [...this._groupTabIds];
  }

  hasAllTabs(): boolean {
    return !this.groupStyle;
  }

  isReady(): boolean {
    return this._ready;
  }

  // How strongly the client holds a tab: 3 when the tab is in its Chrome tab
  // group, 2 when the client attached or will attach the tab, 1 when it only
  // picked the tab up, and 0 when it does not have the tab.
  claimStrength(tabId: number): number {
    if (this._pickedUpTabIds.has(tabId))
      return 1;
    if (this.groupStyle && this._groupTabIds.has(tabId))
      return 3;
    if (this._groupTabIds.has(tabId) || this._connection.claimsTab(tabId))
      return 2;
    return 0;
  }

  // Takes a tab that no client has. Only for a client that has all tabs.
  pickUpTab(tab: chrome.tabs.Tab): void {
    this._groupTabIds.add(tab.id!);
    this._pickedUpTabIds.add(tab.id!);
    this._connection.attachTab(tab);
  }

  async waitForPendingCreates(): Promise<void> {
    await this._connection.waitForPendingCreates();
  }

  close(reason: string): void {
    this._connection.close(reason);
  }

  async releaseTab(tabId: number): Promise<void> {
    this._groupTabIds.delete(tabId);
    this._pickedUpTabIds.delete(tabId);
    await this._connection.detachTab(tabId);
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined)
      return;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    // Without our own group, the user's groups are not ours to act on. A tab
    // dragged into another client's group goes to that client in its attach.
    if (!this.groupStyle)
      return;
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      // Chrome may drop the connect page of a client that is still connecting
      // into our group; that tab is spoken for.
      if (this._isTabReserved(tabId)) {
        void ungroupTabs([tabId]);
        return;
      }
      this._groupTabIds.add(tabId);
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        void this._connection.detachTab(tabId);
    }
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
    this._pickedUpTabIds.delete(tabId);
  }

  private _onTabAttached(tabId: number): void {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    if (this.groupStyle)
      void this._addTabToGroup(tabId);
    else
      this._groupTabIds.add(tabId);
    if (!this._ready) {
      this._ready = true;
      this.onready?.();
    }
  }

  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  private _onTabDetached(tabId: number): void {
    void this._updateBadge(tabId, { text: '' });
  }

  private _onConnectionClose(): void {
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    this._pickedUpTabIds.clear();
    // Without a Chrome tab group the tabs were never grouped by us; the user
    // may have grouped them into their own group, which we must not touch.
    if (this.groupStyle && groupTabs.length)
      void ungroupTabs(groupTabs);
    this.onclose?.();
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || '' }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  private async _addTabToGroup(tabId: number): Promise<void> {
    const groupStyle = this.groupStyle;
    if (!groupStyle || this._groupTabIds.has(tabId))
      return;
    try {
      await retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, groupStyle);
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
    }
  }

}

export async function ungroupTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length)
    return;
  try {
    await retryOnDrag(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]));
  } catch (error: any) {
    debugLog('Error ungrouping tabs:', error);
  }
}

// Chrome throws "user may be dragging a tab" while a drag is in progress.
// Retry with backoff until it clears (or we give up).
async function retryOnDrag(fn: () => Promise<void>): Promise<void> {
  const delays = [0, 100, 200, 400, 800];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay)
      await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await fn();
      return;
    } catch (error: any) {
      if (!error?.message?.includes('user may be dragging a tab'))
        throw error;
      lastError = error;
    }
  }
  throw lastError;
}
