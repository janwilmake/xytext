# Why

- https://x.com/janwilmake/status/1926690572099600500
- https://x.com/dread_numen/status/1930380519239496122
- https://x.com/EastlondonDev/status/1930379050997923846

# How

- ✅ Login with X (or my own oauth provider)
- ✅ `EditDurableObject`: ensures realtime sending and receiving of changes to markdown
- `ContextDO`: contains SQLite with all documents and all contexts of all users, augmented with metadata. Can be DORM to also have one per user/group/organisation but idk yet what makes most sense to shard on.
- sidebar: explorer with files/folders
- left: raw markdown (monaco or other lightweight js solution)
- right: pretty markdown with rich "context-og-deluxe-embeds"

## Bookmarking context

❗️❗️❗️❗️❗️❗️❗️ Bookmark contexts: separate interface that I can just embed as js that allows adding contexts that I bookmark.

- Adds button 🔖 to topleft which opens/closes bookmarks sidepanel
- loads in all bookmarks through context.contextarea.com and renders in nice way showing url, title, tokens, og, may be a bit bigger
- button on every bookmark to remove bookmark or use
- also shows current textarea value ones on top with ability to bookmark
- search on top that searches over titles and urls

The state of bookmark contexts is just a flat list of urls and we can use localStorage to store that as `string[]`. Great thing about it is that we use the already authenticated api of context to expand it into something useful. The UI could just make it possible to send this `string[]` over to a predictable URL that is x-authorized, e.g. https://bookmarks.contextarea.com/janwilmake. This can be done by just using pastebin, then using https://bookmarks.contextarea.com/publish?url={url}. This would authenticate, then set the value, making it shareable everybody.

The 'personal context base' should be available publicly as well! this in turn allows turning this into a simple fetch mcp to gather a context prompt!

# ideas

This `contextbuilding` component has loads of usecases so generally a live DO to render information dynamically is super dope. Let's start with markdown and rendering this in different ways

- https://letmeprompt.com/i-want-to-make-a-new-ce28o20
- initial design: https://letmeprompt.com/i-want-to-make-a-new-cke1710

This'd be super cool, combining several feeds into a live markdown document

- recent repos
- open stripe dashboard
- googllm seach
- recent tweets
- new prompt

It'd be great if i had a markdown syntax to easily build simple forms. Maybe, it makes most sense to use a regular URL with empty query params. This signals they need filling. Also GREAT for lmpify, btw.
