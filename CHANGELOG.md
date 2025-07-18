# June 28

Initial implementation that broadcasts file content to all clients

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

TODO

- ✅ every html should have filename as as title
- ✅ sidebar links use `window.open(path,path).focus()`
- ✅ Extension-based favicon
- ✅ Move 'logout' to footer, remove header too
- ✅ For now, hide tabs
- Entire tabs logic can be removed, we are leveraging Chromes state of open tabs and pinning.

# other high-impact improvements

- ✅ Don't expose SQL, just studio with `queryable-object`
- ✅ Put button https://letmeprompt.com/from/{url} in footer
