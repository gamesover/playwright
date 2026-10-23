# Playwright Chrome Extension

## Introduction

The Playwright Chrome Extension allows you to connect to pages in your existing browser and leverage the state of your default user profile. This means the AI assistant can interact with websites where you're already logged in, using your existing cookies, sessions, and browser state, providing a seamless experience without requiring separate authentication or setup.

## Prerequisites

- Chrome/Edge/Chromium browser

## Installation Steps

### Install the Extension

Install [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) from the Chrome Web Store.

### Configure Playwright MCP server

Configure Playwright MCP server to connect to the browser using the extension by passing the `--extension` option when running the MCP server:

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension"
      ]
    }
  }
}
```

## Let an AI Agent Use Your Chrome

With an authentication token and the `--no-tab-group` option, an AI agent can use your Chrome the way you do: it reaches all your open tabs, the tabs you open later, and the sites you are signed in to. No approval dialog is shown, and no tab group is created.

### 1. Copy the Token

Click the extension icon to open the status page. Copy the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` value. The token is unique to your browser profile.

### 2. Configure the MCP Server

Pass `--extension` and `--no-tab-group`, and set the token:

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension",
        "--no-tab-group"
      ],
      "env": {
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "your-token-here"
      }
    }
  }
}
```

The `PLAYWRIGHT_MCP_NO_TAB_GROUP=1` environment variable can be used instead of the `--no-tab-group` option.

To keep the token out of the MCP configuration file, set both variables in your shell profile, for example `~/.zshrc`, and pass only `--extension` in the configuration:

```sh
export PLAYWRIGHT_MCP_EXTENSION_TOKEN=your-token-here
export PLAYWRIGHT_MCP_NO_TAB_GROUP=1
```

The MCP server gets these variables only when the MCP client starts from that shell, for example a client that you run in a terminal. Apps that you start from the desktop or the Dock usually do not read the shell profile. For them, set the variables in the `env` block of the configuration.

### 3. Start Working

When the agent uses the browser for the first time, Chrome opens the extension's connect page. The page connects at once, without a dialog, and becomes the agent's first tab. After that, the agent gets all other tabs. Ask the agent to list the tabs, switch to one, read it, or act on it, for example: "Find my open GitHub tab and summarize the pull request."

These tabs are not available to the agent:
- Pages that cannot be debugged, such as `chrome://` pages and extension pages.
- Discarded tabs, until you open them again.
- Tabs that another client is connected to.

If you move a tab into or out of one of your own tab groups, the agent keeps it.

### 4. Watch and Stop the Agent

- A `✓` badge on the extension icon shows that the current tab is connected.
- The status page lists every connection and its tabs. Click **Disconnect** to stop a connection.
- When the agent's MCP server stops, the connection closes.

### Security

The agent can read and change everything in the tabs it reaches. This includes your signed-in sessions, cookies, and the content of every page. Any program that has the token can connect without approval. Keep the token secret. If you think someone else has it, click the refresh button next to the token on the status page ("Generate new token"), and then restart the browser.

### Other Clients

Other clients can connect at the same time, with or without a tab group. A tab goes to another client when that client selects it in its connect page, opens it, or gets it when you drag the tab into its group. A client with access to all tabs cannot take a tab from another client. When another client lets go of a tab or disconnects, the agent with access to all tabs gets that tab.

An out-of-date extension ignores `--no-tab-group`, creates a tab group, and gives the agent only the tabs in that group.

## Usage

### Browser Tab Selection

When the LLM interacts with the browser for the first time, it will load a page where you can select which browser tab the LLM will connect to. This allows you to control which specific page the AI assistant will interact with during the session.

### Multiple Clients

Several clients can be connected at the same time. Each one gets its own tab group, named after the client and colored apart from the other groups, and only sees the tabs in that group — a tab can belong to a single client at a time. A client started with `--no-tab-group` has no group and gets all free tabs instead, see [Let an AI Agent Use Your Chrome](#let-an-ai-agent-use-your-chrome). Drag tabs in and out of a group to change what a client can reach, and use the extension's status page to see every connection and disconnect them individually.

### Bypassing the Connection Approval Dialog

By default, you'll need to approve each connection when the MCP server tries to connect to your browser. To bypass this approval dialog and allow automatic connections, you can use an authentication token.

#### Using Your Unique Authentication Token

1. After installing the extension, click on the extension icon or navigate to the extension's status page
2. Copy the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` value displayed in the extension UI
3. Add it to your MCP server configuration:

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension"
      ],
      "env": {
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "your-token-here"
      }
    }
  }
}
```

This token is unique to your browser profile and provides secure authentication between the MCP server and the extension. Once configured, you won't need to manually approve connections each time.

### Selecting a Chrome Profile

If the extension is installed in several Chrome profiles, the connection is made to the one you used last. To always connect to a specific profile, pass the name of its directory, the last component of "Profile Path" at `chrome://version`, via `--profile-dir-name`:

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension",
        "--profile-dir-name",
        "Profile 2"
      ]
    }
  }
}
```

The `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` environment variable can be used instead of the option. The authentication token is specific to the profile, so use the one displayed in that profile.


