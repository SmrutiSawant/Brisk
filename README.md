# Brisk

A lightweight, privacy-focused web browser built with Electron and Chromium.

Brisk uses Chromium to render web pages, while the browser interface and privacy features are built from scratch. It blocks ads and trackers, uses encrypted DNS, upgrades connections to HTTPS, blocks third-party cookies, and keeps device permissions disabled unless you explicitly allow them.

The interface follows a simple light, monochrome design to give it a different feel from browsers like Chrome.

All privacy protections are enabled by default, but you can change them whenever you want from the shield icon in the toolbar. The idea is simple: privacy settings should be easy to understand and control, not hidden away somewhere in the browser.


## Getting Started

Open PowerShell or Command Prompt in the project directory and run:

```bash
cd C:\Browser
npm install
npm start
```

The first installation downloads Electron and its Chromium binaries (around 200 MB), so it may take a few minutes. Once everything is installed, you can launch the browser using `npm start`.

## Running on Windows vs WSL

Brisk is designed to run on Windows. Although it can also run through WSL, some Electron features behave differently because WSL uses WSLg to display Linux applications.

A few issues you might encounter when running through WSL:

| Issue | Reason |
|---|---|
| Window doesn't fill the screen properly | WSLg uses a virtual display instead of directly accessing your monitor |
| Scrolling and dragging feel choppy | Hardware acceleration may not work correctly |
| Window controls don't appear or respond | `titleBarOverlay` is a Windows-specific Electron feature |

The application detects the operating system and uses the regular title bar on Linux to avoid some of these issues. However, running it directly on Windows gives you the intended experience.

**Moving from WSL to Windows**

If you've already installed dependencies through WSL, delete the existing `node_modules` folder before reinstalling. It contains Linux-specific binaries that won't work on Windows.

Run the following commands in PowerShell:

```powershell
rmdir /s /q node_modules
npm install
npm start
```

Make sure Node.js is installed on Windows itself. A Node.js installation inside WSL cannot be used by PowerShell.

## Features

### Privacy and Tracking Protection

**Ad and tracker blocking**

Brisk uses `@ghostery/adblocker-electron` with EasyList and EasyPrivacy filters to block ads and trackers automatically. The toolbar also displays how many requests have been blocked on the current page.

**Search engines**

Brisk provides four search engine options:

| Search engine | What it's useful for |
|---|---|
| SearXNG (default) | General-purpose search using results from multiple search engines |
| Marginalia | Finding blogs, essays, independent websites, and text-heavy content |
| DuckDuckGo | A reliable alternative for everyday searches |
| Google | The widest index, when nothing else finds it |

The selected search engine is saved, so you don't have to choose it every time you open the browser.

SearXNG and Marginalia are open-source and can also be self-hosted.

**Tracking parameter removal**

When you navigate to a URL, Brisk removes common tracking parameters such as `utm_*`, `fbclid`, `gclid`, `msclkid`, `igshid`, and others.

These parameters are often used to track where a visitor came from. Removing them usually doesn't affect the page itself.

### Network Privacy

The browser applies several protections to reduce the amount of information websites and network providers can collect.

| Protection | Purpose |
|---|---|
| HTTPS-only navigation | Tries to use secure connections for every website. If HTTPS isn't available, you can choose whether to continue using an insecure connection |
| Encrypted DNS | Uses DNS over HTTPS (Quad9 by default) so your ISP and local network cannot easily see the domains you're looking up through ordinary DNS |
| Third-party cookies blocked | Prevents embedded third-party services from using cookies to track you across websites |
| Referrer restrictions | Sends only the website's origin when navigating between different sites, instead of revealing the complete page URL |
| Global Privacy Control | Sends `Sec-GPC: 1` to communicate your preference against the sale or sharing of personal data |
| Client data removal | Removes Chromium's `X-Client-Data` header from Google requests |
| Client Hints restrictions | Removes high-entropy browser information, such as detailed device and OS information, while keeping commonly shared low-entropy hints |
| Network reporting disabled | Removes `NEL` and `Report-To` headers to limit network telemetry |
| WebRTC restrictions | Restricts WebRTC to the public network interface to reduce local IP address leaks |
| Background networking disabled | Disables features such as link click reporting and unnecessary background requests |
| Privacy Sandbox disabled | Turns off features such as Topics, FLEDGE, Attribution Reporting, and Shared Storage |

### Device and Local Privacy

- **Device permissions:** Location, camera, microphone, screen sharing, clipboard reading, Bluetooth, USB, MIDI, and other device permissions are denied by default. If a website requests access, a small indicator appears on the shield icon. You can review the request and grant permission to individual sites from there.
- **Private browsing:** Press `Ctrl+Shift+N` to open a private tab. Private tabs use a separate storage partition with their own cookies and website data. They aren't included in the reopen-closed-tabs list, and their data is cleared when the browser closes.
- **Download protection:** Executable files trigger a warning before being downloaded. The browser also asks where you want to save every download.
- **Browsing data:** You can clear browsing data whenever you want using `Ctrl+Shift+Del`. The browser also clears configured data when it exits.
- **Certificate validation:** Websites with invalid certificates are not silently accepted. This helps prevent situations where someone might be intercepting your connection.

### Browser Security

A key part of Brisk's design is treating every website as untrusted content.

To keep website code separate from the browser itself:

- Renderer processes run with sandboxing enabled.
- Websites don't get access to Node.js or the browser's preload scripts.
- Context isolation is enabled.
- Webview preferences are controlled by the main process rather than being trusted from page markup.
- Navigation is restricted to allowed URL schemes. Dangerous `javascript:` and top-level `data:` navigations are blocked.
- Local `file:` navigation is restricted to the new tab page.
- The browser's own interface runs with a Content Security Policy that doesn't allow inline scripts.
- Websites cannot open arbitrary browser windows.
- IPC messages are checked to make sure they come from the expected sender.
- Settings are validated in the main process before being saved or applied.

These checks help prevent a website or a modified settings file from gaining access to parts of the browser it shouldn't be able to control.

### A Note on Browser Fingerprinting

Brisk deliberately doesn't try to randomize browser fingerprints.

Changing the user agent, randomizing canvas output, or pretending to be a different browser can sometimes make a browser easier to identify rather than harder. For example, claiming to be Firefox while actually behaving like Chromium creates an unusual combination of signals.

Instead, Brisk keeps commonly shared browser information consistent and removes unnecessary identifying details.

It also removes the `Brisk/0.1.0 Electron/32` tokens from the user agent so websites don't immediately identify it as this particular application.

Proper fingerprinting protection, like the approach used by Tor Browser, requires much more extensive work to make users appear similar to one another. Brisk doesn't claim to solve that problem.

## Browsing Experience

Brisk includes the basic features you'd expect from a desktop browser:

- A custom new tab page with a clock, greeting, search box, and quick links.
- Multiple tabs with support for opening, closing, and switching between them.
- Middle-click to close a tab.
- An address bar that distinguishes between URLs and search queries.
- Back, forward, reload, stop, and home controls.
- Live page titles and favicons in the tab strip.
- Loading indicators for active tabs.
- Links using `target="_blank"` open in a new tab.
- A minimal light interface with rounded tabs and a floating page layout.
- Custom window controls integrated into the tab strip.
- **Screen & Tab Casting:** Cast the active tab, entire desktop screen, or browser window to Smart TVs, phones, tablets, or other computers across the local Wi-Fi with zero installation on the receiver. Features an embedded low-latency WebSocket/MJPEG stream server, instant QR code scanning, UPnP/DLNA and Google Cast discovery, and direct 1-click playback on DLNA Smart TVs.

### Keyboard Shortcuts

Shortcuts work even when you're interacting with a website inside a tab.

| Shortcut | Action |
|---|---|
| `Ctrl+T` | Open a new tab |
| `Ctrl+Shift+N` | Open a private tab |
| `Ctrl+Shift+T` | Reopen the last closed tab |
| `Ctrl+W` | Close current tab |
| `Ctrl+L` | Focus the address bar |
| `Ctrl+R` | Reload page |
| `Ctrl+Shift+R` | Hard reload |
| `Ctrl+D` | Bookmark / edit bookmark for current page |
| `Ctrl+Shift+B` | Toggle bookmarks bar |
| `Alt+C` / `Ctrl+Shift+K` | Cast screen or tab to other devices |
| `Ctrl+Tab` | Switch to next tab |
| `Ctrl+Shift+Tab` | Switch to previous tab |
| `Alt+Left / Right` | Navigate back / forward |
| `Ctrl+Shift+Del` | Clear browsing data |
| `F11` | Toggle fullscreen |
| `F12` | Open DevTools |

F12 works for both the browser interface and the currently focused website.

## Project Structure

The project is split into a few main files, with each one handling a specific part of the browser.

| File | Responsibility |
|---|---|
| `main.js` | Creates the application window, manages webviews, handles IPC, keyboard shortcuts, and popup restrictions |
| `privacy.js` | Handles privacy settings, session security, request headers, permissions, HTTPS enforcement, DNS, and downloads |
| `preload.js` | Provides a limited and secure bridge between the main process and browser interface |
| `index.html` | Contains the browser interface, including the tab strip, toolbar, privacy panel, and styling |
| `renderer.js` | Handles tabs, navigation, URL parsing, keyboard shortcuts, and the privacy panel |
| `cast.js` | Implements screen and tab casting, local WebSocket/MJPEG streaming, QR code generation, and DLNA/Cast discovery |
| `bookmarks.js` | Handles persistent bookmark storage, validation, querying, and live notifications |
| `newtab.html` | Defines the custom new tab page |
| `newtab.js` | Handles new tab functionality and quick links |
| `ROADMAP.md` | Lists planned features and future improvements |

One important design decision is keeping `main.js` and `privacy.js` separate. The main process manages the application window and browser behaviour, while `privacy.js` contains the logic responsible for protecting browsing sessions and user data.

This makes the privacy-related code easier to find, review, and maintain.

## What's Not Implemented Yet

Some features have been left out to keep the initial version manageable.

- Browsing history.
- A downloads panel to view and manage downloaded files.
- Find-in-page.
- Page zoom controls.
- Drag-and-drop tab reordering.
- Additional per-site browsing containers.

These can be added in future iterations. Persistent storage, for example, could be handled using `electron-store` or another suitable storage solution.

## Things to Keep in Mind When Making Changes

A few parts of the application depend on matching values or behaviour across multiple files. If you're modifying these areas, make sure the related code is updated as well.

### Window Colours and Dimensions

The following values need to stay consistent:

- `titleBarOverlay` in `main.js` should match the tab strip background (`#e6e6e6`) and height (`40px`) in `index.html`.
- Its `symbolColor` (`#111111`) should match the `--text` CSS variable.
- The window's `backgroundColor` should match the page gutter colour (`#f7f7f7`).
- `nativeTheme.themeSource` is set to `light`. Change it to `system` if you want the browser to follow the operating system's theme.
- The tab strip uses `padding-right: 148px` to leave space for the native window controls.

Changing one of these values without updating the others can make the interface look inconsistent.

### Settings Validation

All browser settings are stored in `settings.json` inside Electron's `userData` directory.

Settings are loaded when the application starts and saved whenever something changes. Each setting is checked against its corresponding validator in `main.js`.

If a setting doesn't pass validation, the browser uses its default value instead.

Whenever you add a new setting, update both:

- `DEFAULT_SETTINGS`
- `VALIDATORS`

If you forget to add a validator, the setting won't be accepted when the UI tries to save it.

### Private Browsing Configuration

The `PRIVATE_PARTITION` value must match between `main.js` and `renderer.js`.

The main process checks which partition a webview is allowed to use, while the renderer assigns the partition when creating a private tab.

If these values don't match, private tabs may accidentally use the regular persistent session instead.

### HTTPS Error Handling

`NO_HTTPS_ERRORS` is another value that needs to stay consistent across both processes.

Both `main.js` and `renderer.js` use this list to distinguish websites that genuinely don't support HTTPS from other network errors, such as being offline.

If you update the list in one place, make sure to update the other too.

### Keyboard Shortcuts

Keyboard shortcuts are handled in two places because website tabs run in separate renderer processes.

- `before-input-event` in `main.js` catches keyboard input from the currently focused webview.
- The window keyboard listener in `renderer.js` handles shortcuts when the browser interface has focus.

Both paths use the same `runAction` logic to perform the actual action.

When adding a shortcut, update:

- `matchShortcut` in `main.js`
- `shortcutFor` in `renderer.js`

Also, if an action needs to interact with the browser UI, add it to `FOCUS_UI` in `main.js` so the application window receives focus first.

The main process only forwards shortcuts when the focused webContents is a webview. This prevents shortcuts from being executed twice when the browser interface already has focus.

### Ad Blocker and Request Listeners

Electron allows only one listener per `webRequest` event for each session. Registering another listener for the same event replaces the previous one.

This matters because the ad blocker already uses some of these events.

The current setup is:

| Event | Handler |
|---|---|
| `onBeforeRequest` | Ad blocker |
| `onHeadersReceived` | Ad blocker and our privacy pipeline |
| `onBeforeSendHeaders` | Our privacy pipeline |

The `onHeadersReceived` event needs special handling. Our `installHeaderPipeline()` function calls the blocker's existing handler first, then applies our own header modifications.

This allows both the ad blocker's CSP changes and our third-party cookie restrictions to work together.

There's also an important startup detail:

1. The session is configured with its privacy settings.
2. The ad blocker loads asynchronously and registers its listeners.
3. Once it finishes loading, `installHeaderPipeline()` is called again with the blocker instance.

This restores our header pipeline on top of the blocker's handler.

If the third-party cookie restrictions suddenly stop working, this is one of the first places to check.

Tracking parameter removal is handled separately in `renderer.js` because the ad blocker already owns the `onBeforeRequest` event.

### HTTPS Enforcement

HTTPS enforcement is implemented in both `main.js` and `renderer.js`.

This is intentional because Electron's `will-navigate` event doesn't cover every navigation started programmatically.

- `main.js` handles navigation initiated by websites, such as link clicks and redirects.
- `renderer.js` handles navigation initiated by the user, such as entering a URL in the address bar or opening a new tab.

Both processes also maintain the HTTPS exception list. When a user chooses to continue to a site without HTTPS, the exception is added to both lists.

Keeping these two paths in sync ensures that HTTPS protection works regardless of how a page is opened.

### Webview Visibility

Avoid setting `display: none` directly on a `<webview>` element.

Electron relies on the webview's layout behaviour to size the guest page correctly. Hiding it this way can cause rendering and sizing problems.

Instead, each webview is placed inside a `.view-wrap` container, and the container's visibility is changed when switching tabs.

## Known Trade-off: Webview vs WebContentsView

Brisk currently uses Electron's `<webview>` element because it makes tab management relatively straightforward.

Electron recommends considering `WebContentsView` for applications that need more control over embedded content.

With `WebContentsView`, tab management and positioning have to be handled from the main process, including manually updating the position and size of each view.

For now, `<webview>` keeps the implementation simpler. Moving to `WebContentsView` is something worth considering if the project grows further.

## SearXNG Troubleshooting

Sometimes SearXNG may return:

**"No results were found."**

This doesn't necessarily mean the instance is offline.

SearXNG works by forwarding searches to other search engines and combining their results. Public instances often run into problems when upstream providers block their requests, especially when the instance receives a lot of automated traffic.

When that happens, the instance may still be accessible but unable to retrieve search results.

Brisk lets you change the SearXNG instance directly from the search engine picker in the toolbar. You can enter another instance or select one of the available suggestions. Your selection is saved.

You can find other public instances at [searx.space](https://searx.space).

**Running your own SearXNG instance**

If you want more control, you can run your own instance using Docker:

```bash
docker run -d -p 8888:8080 searxng/searxng
```

Then enter the following address in Brisk's SearXNG instance field:

```text
http://localhost:8888
```

The instance field allows localhost addresses and bare IP addresses, in addition to public hostnames.

Marginalia isn't affected by the same issue because it maintains its own crawler and search index.

One small implementation detail: Marginalia expects the search parameter to be `query=` rather than `q=`. That's why the new tab page updates the form's field name as well as its action URL.
