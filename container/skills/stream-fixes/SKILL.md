---
name: stream-fixes
description: >-
  Run a stream of quick fixes to a web app while people watch it change through a live
  preview link. Use when someone says they will stream fixes, feedback or changes in quick
  succession against a running app, or starts calling out small UI/bug/polish fixes one
  after another. Not needed for a stream of edits to a document or deck.
---

# stream-fixes

Number each fix in the order it arrives (1, 2, 3…) so anyone in the thread can refer to it,
hand it to a background sub-agent (or do it yourself if it is tiny), answer in a line, and take
the next one. These rules exist because sub-agents share one checkout and one running app:

1. **One checkout, one branch, one running app.** `create_worktree` once, with a branch such as
   `stream-fixes/<area>-<YYYY-MM-DD>`. Start and share the app from it as the live-preview
   skill says, and post the link. Every fix lands
   in that checkout, so the link shows all of them. Never give a sub-agent its own worktree or
   branch.
2. **Sub-agents edit; you commit.** Tell each sub-agent not to commit and to report the exact
   paths it changed. Commit each fix yourself with `git add <those paths>`, with the fix number
   in the message. Never `git add -A`, `commit -a` or `--amend`: other fixes are in flight in the
   same tree. A fix touching the same files as one in flight waits for it.
3. **Done means seen working.** Every fix, yours or a sub-agent's, is reproduced in the running
   app, fixed, and watched working; if the bug can't be reproduced or the fix can't be seen
   working, say so instead of reporting it done. Sub-agents use agent-browser on
   `http://127.0.0.1:<port>` with their own `--session`, not the preview URL, and close the
   session when done.
4. **At most three sub-agents at once**, since each drives a browser in this container.
5. **Backend fixes run here too.** When a fix needs the backend, run it in this container as
   the live-preview skill says, so it lands as fast as a frontend fix. If the repo can't run its
   backend here, say which fixes wait for the PR.
6. **Ship on the user's word: small fixes in one PR, big items in their own.** Nothing is pushed
   mid-stream. A big item (a new feature or screen, a migration, a rewrite, anything risky enough
   to need its own review; when unsure, small) is still built on the branch so the link shows it,
   but commit it apart from the fixes and say it is big when it comes in. When they say ship,
   open one PR for the small fixes and one per big item, each a fresh branch from the base
   carrying only its own commits (cherry-picked), so no big item rides in the small-fix PR. The
   small-fix PR lists each numbered fix.
7. **Finishing a batch is not ending the session.** "Done" after a run of fixes means that batch
   is done; others in the thread may still be using the link. Run `ncl preview close` and stop
   the app only when someone says to close the preview, or after shipping. If "done" could mean
   either, keep everything running and ask once whether to close the preview too. An open
   preview keeps the container up for up to 8 hours.
