# todo-nag app

The phone app for [todo-nag](https://github.com/swagbot5000/todo-nag) (private). This repo only holds the app's code.
Tasks live in the private repo, and the app reads them with a token stored on each phone.

**Open:** <https://swagbot5000.github.io/todo-nag-app/>

## Install on a phone (Android, Chrome)

1. Open the link above in Chrome.
2. Paste a GitHub token. The phone's existing shortcut token works; copy it from the `gh_token` variable in HTTP Shortcuts.
   It needs **Actions: Read and write** and **Contents: Read-only** on `todo-nag`.
3. Pick who you are.
4. Chrome menu (⋮) → **Add to Home screen** → **Install**.

Long-press the app icon for an **Add task** shortcut. You can also *share* text from another app to "To do" to turn it into a task.

## Using it

- **Add:** type, optionally tap High/Med/Low, Me/Sarah/Either and a due date, then press +.
  Inline extras still work: `@fri`, `!h`, `+open`.
- **Done:** tap the circle. You have 4 seconds to undo (tap it again, or tap *Undo*).
- **Snooze a day:** swipe a task left.
- **Everything else** (snooze longer, priority, who it's for, delete): tap the task.

Changes appear immediately. GitHub takes about 30 seconds to actually save them; until then the task shows a pulsing
dot and the header says "Saving". Changes made offline are kept and sent when you're back online. If GitHub doesn't
confirm a change within 3 minutes, the task says so and offers *Send again*.

## How it works

- **Reads:** `lists/<you>.json` from the private repo, via the GitHub API. That file is written by the repo's Python script, so all the labelling and escalation rules live there, not here.
- **Writes:** starts the same `add-task` / `task-action` workflows the HTTP Shortcuts use.
- **Stored on the phone (`localStorage`):** the token, who you are, the last list, and unsent changes. *Settings → Forget token on this phone* clears them.

Every GitHub Pages site under `swagbot5000.github.io` shares that storage. Only publish your own code there.

Files: `index.html`, `style.css`, `app.js` (all logic), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.
After changing the app, bump `CACHE` in `sw.js` so phones pick up the new version.
