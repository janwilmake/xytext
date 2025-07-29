# June 28

Initial implementation that broadcasts file content to all clients

# How

- ✅ Login with X (or my own oauth provider)
- ✅ `EditDurableObject`: ensures realtime sending and receiving of changes to markdown
- ✅ sidebar: explorer with files/folders

# July 4th

✅ Added massive amount of functionality: tabs and hierarchical navigation. Did this by having just a single table datamodel. Designed it like this with efficiency top of mind. tabs and navigation state is also broadcasted.

- is_tab_pinned goes back to FALSE after you change the pinned file again
- commands should be registered IN the editor (cmd+K, shift+enter for pinning, ctrl/cmd+W for closing file)
- command palette also openable with cmd+shift+p
- add line, column to data model of every node. when saving content, also store line and column
- when opening a file, editor should focus on previous line/column
- need 'move' api to move files/folders. in frontend, this should look like drag/drop.
- need 'rename' in explorer right click menu (and api for it to do it)
- when clicking below the last line, it should NOT select the entire contents, rather, it should put the cursor at the last column of the last line.
- add adherence to system theme, adding light mode

give me a full new implementation

# Huge simplification by leveraging target (2025-07-18)

I made this POC: https://letmeprompt.com/rules-httpsuithu-n4xrr10 https://targettabs.gptideas.com

With sidebar: https://letmeprompt.com/rules-httpsuithu-y4kcl40 https://targetfiles.gptideas.com

As can be seen, the concept doesn't work so well on safari, but it works perfectly on chromium. However, it seems webkits implementation is more according to the spec while chromium is a bit more liberal. Other browsers are split on this, firefox might work, edge likely also works since it's chromium-based.

https://letmeprompt.com/rules-httpsuithu-8awukl0

It may be possible create a safari extension that gets us the desired behavior.

https://letmeprompt.com/rules-httpsuithu-ys708o0

An extension is desired anyways because I'd want to allow anyone to view what I'm doing in the browser (and store it for ai-agent context-use)

- ✅ every html should have filename as as title
- ✅ sidebar links use `window.open(path,path).focus()`
- ✅ Extension-based favicon
- ✅ Move 'logout' to footer, remove header too
- ✅ For now, hide tabs
- ✅ Entire tabs logic can be removed, we are leveraging Chromes state of open tabs and pinning.
- ✅ Don't expose SQL, just studio with `queryable-object`
- ✅ Put button https://letmeprompt.com/from/{url} in footer

## Reduce lines of code in main file (2025-07-19)

- ✅ Remove all tab stuff
- ✅ Ensure it streams just one file content, not all files!
- ✅ Problem 1: It streams all files it seems rather than one

## View who's viewing/editing what (2025-07-19)

- ✅ We get user details in frontend in `user` and in `sessions`, including profile pictures
- ✅ Every logged in person viewing a page should send a heartbeat to that file when opened and when closed. do this in `this.sessions`
- ✅ join, leave, and init get sent rich sessions that include `is_tab_foreground`
- ✅ `ui_state` keeps `last_open_path` and `is_tab_foreground` per username
  - when leaving the tab, should set `is_tab_foreground:false`
  - when entering a tab, should set `is_tab_foreground:true` after 10ms delay (to prevent race conflict)
  - when opening a new session, should set `is_tab_foreground:true`
- ✅ to render explorer, turn sessions into a mapped object from `path` to unique users that have `is_tab_foreground:true`
- ✅ In the explorer, render all unique users profile images after each file (replace \_400x400 with \_normal)
- ✅ Separate sidepanel section listing all users.
  - Shows image a bit bigger (50x50)
  - Clicking username opens them on X.com/{username} in new tab with target {username}
  - Follow/unfollow button sets key `follow_{firstSegment}`: null or string into localStorage. When set for current firstSegment, listener for session events looks up configured user `is_tab_foreground:true` page of configured username and navigate when it does not equal current page using `window.location.href`
- ✅ After finding that it was incredibly glitchy, decided not to use localStorage and precalculate things on the server.
- 🤔 the profile image render is still a little glitchy but it's a lot better now. it seems that the `init` updateUI rerender refreshes the entire image even though it was preloaded
