# CRITICAL

## OAuth Login

- Need to login into lmpify
- Need to login into flaredream deploy
- Login into patch for github
- Login into github

Keep all this state in a logins table belonging to the user

## Terminal or other way to perform actions

I need to be able to do arbitrary file transformations to these files. For this, it's probably best to allow any other tool access. For this we need this to be an oauth PROVIDER.

Main terminal things I do:

- run little scripts on fs
- git clone
- github patching (or git push)
- download all files
- test a curl

I can be creative in my solution, it doesn't need to 1:1 match the original git (as this can be hard). Even just having deployment is already extremely valuable.

## Custom named generations (this is also an action applying a single file to an API)

Just like the prompt button, what if we had a button to see the last-generated outcome in gptideas? Since hyphens aren't allowed in X usernames, what if https://{filename}-janwilmake.xytext.com would be tied to the generation? Maybe this is what I'm ACTUALLY LOOKING FOR?

- In lmpify, choosing a name is likely an awkward experience, whereas in a file editor it's much more intuitive.
- In lmpify we can choose the model, in xytext, maybe we should provide it as built-in thing we just know works, and has a built-in system prompt!

After I have the MCP with deployment and that's an API

- login with cloudflare from xytext
- use `/{filepath-slug}-{username}` with lmpify API with flaredream systemprompt and deploy MCP deployed to hostname that is inferred from filename unless defined in wrangler.

# MORE

## View who's viewing/editing what

- Every logged in person viewing a page should send a heartbeat to that file that is either active or inactive.
- In the sidebar, all files an owner has OPEN are given a white dot for each person that has it open, a orange dot for each person that has it active, a green dot for each contributor that has it active.
- Separate sidepanel section showing all user imgs. clicking on their icon opens the file they are viewing

## Binary files

- we may already be able to just put base64 in TEXT or add a BLOB column and use this for binary files. with this, files would go up to 2MB
- we'll need a blocks table setup connected to the nodes table for binary files over 2mb. less important as this shouldn't be there for most repos.

## Search (file-content search, path search)

This is gonna be tricky
