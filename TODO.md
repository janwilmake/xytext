TODO:

- People should be able to see the main person is doing by having my the profilepic on the filename if present.
- Make SQL read only

# Binary files

- we may already be able to just put base64 in TEXT or add a BLOB column and use this for binary files. with this, files would go up to 2MB
- we'll need a blocks table setup connected to the nodes table for binary files over 2mb. less important as this shouldn't be there for most repos.

#

# Search (file-content search, path search)

This is gonna be tricky

# Terminal

I need to be able to do arbitrary file transformations to these files. For this, it's probably best to allow any other tool access. For this we need this to be an oauth PROVIDER.

# Custom named generations?

Just like the prompt button, what if we had a button to see the last-generated outcome in gptideas? Since hyphens aren't allowed in X usernames, what if https://{filename}-janwilmake.xytext.com would be tied to the generation? Maybe this is what I'm ACTUALLY LOOKING FOR?

- In lmpify, choosing a name is likely an awkward experience, whereas in a file editor it's much more intuitive.
- In lmpify we can choose the model, in xytext, maybe we should provide it as built-in thing we just know works, and has a built-in system prompt!
