Alternatives approach: https://github.com/yjs/yjs

Icons: https://github.com/microsoft/vscode-icons/tree/main/icons/dark

# ✅ Follow functionality

if turned on, any (anonymous or not) user should be able to follow ANYONE viewing the files by listening on broadcasted active tab changes in the active tab. This would simply `window.open(path,path).focus()`. Readonly users should autofollow the first other active user on the same file, if any, unless turned off. This would really make this thing amazing, and would make me fully disable the tabs thingy altogether.

After some research (see https://letmeprompt.com/rules-httpsuithu-9bkkyt0 and https://tabroulette.gptideas.com) i found that `window.open` is often blocked by popup blockers and most users need to allow it (sometimes without any gesture by the browser) before it works, and `window.open(path,target).focus()` also doesn't work, unfortunately. This means following with tabs wouldn't work:

```
**Unfortunately, there's no persistent focus permission that works across the entire session.** Here's why:


**Transient Activation**: User activation expires after ~5 seconds
**No Session-Wide Permission**: Unlike camera/notification permissions, focus can't be granted permanently
**Security by Design**: Browsers intentionally prevent persistent programmatic focus to avoid abuse
```

That said, following could still be done using `window.location.href`! It just strikes me, that is probably also less intrusive for people. When things are happening in 1 tab, people can navigate away from following someone while the following continues. that's actually much better!

See the POC here

https://letmeprompt.com/rules-httpsuithu-cx2ox70

https://locationroulette.gptideas.com/

Initial version done in the same day!
