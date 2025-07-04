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
