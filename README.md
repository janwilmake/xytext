Collaborative Text Editor with X OAuth Authentication

- Durable objects based on path segments
- X OAuth for write permissions
- SQLite storage for persistence

Initial Prompt: https://lmpify.com/httpsuithubcomj-niymxy0

The first version still had lot of bugs. Finally, it became a lot easier after:

- moving to typescript
- putting all logic inside of the durable object to just have a single fetch handler where everything happens, rather than several.

License: MIT

By Jan Wilmake. [Discuss](https://x.com/janwilmake/status/1930894240403382433)

TODO:

- Ability to import github repos (preferably full blown terminal)
- Easy ability to open the file as its own mediatype (could simply open at https://raw.xytext.com/...)
- Pinned and open files with the same VSCode shortcuts
- Improved exlorer with folders similar to VSCode
