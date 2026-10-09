# Third-party notices

## browser-use/jev-ultrafast

Parts of this project are derived from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
(commit 1231850), under the MIT License below:

- `extension/snapshot.js` is derived from `jev_ultrafast/snapshot.js`. Changes: same-origin iframes (with
  frame-aware page keys and coordinates), open shadow roots, design-system web components without ARIA roles, and
  fewer duplicate targets in menus and grids.
- `run_goal`, `TabBrowser` and `fingerprint` in `host/jev_voice_host.py` follow the agent loop of
  `jev_ultrafast/agent.py` and the observe / fresh / act interface of `jev_ultrafast/browser.py`, with the browser
  side carried out by the extension instead of the DevTools protocol.
- `actInPage` in `extension/panel.js` adapts the input step of `jev_ultrafast/browser.py` (element checks and hit
  test before a click or a keystroke) to DOM events.

The host also installs jev-ultrafast itself as a dependency (`host/pyproject.toml`).

```
MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
