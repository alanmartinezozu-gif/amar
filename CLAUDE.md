# Project notes for Claude

## Websites and web pages: use Hallmark

Use the **hallmark** skill (`.claude/skills/hallmark`, run as `/hallmark`) for any website or web page work in this repo: landing pages, marketing sites, lead-capture forms, the admin UI in `src/admin/views.ts`, and any other HTML/CSS. Load it before you write the first line of markup. The owner asked for Hallmark on all web work, so treat that as naming it:

- New page or site: `/hallmark <prompt>`, then follow its flow (ask once, deal a theme, hero first, sweep).
- Rebuild an existing page and keep its content and wiring: `/hallmark redesign <path>`.
- Review a page without changing it: `/hallmark audit <path>`.

For a small fix to an existing page (a typo, a broken link, one new field), don't redesign it. Make the change in the page's own style and keep it within Hallmark's Floor (the numbered list at the top of `SKILL.md`).

### Running its checks

The static lint needs only Node: `node .claude/skills/hallmark/scripts/sloplint.mjs <file>`.

The browser checks (`--render`) also need `puppeteer-core` and Chromium. In a cloud session, install `puppeteer-core` first; the container doesn't keep it between sessions:

```bash
npm i -g puppeteer-core
```

Then point `CHROME_PATH` at the wrapper, because Chromium won't start as root unless its sandbox is off:

```bash
CHROME_PATH=.claude/scripts/chromium-no-sandbox.sh node .claude/skills/hallmark/scripts/sloplint.mjs <file> --render
```

On a local machine with Chrome installed, `npm i -g puppeteer-core` is enough. The skill finds Chrome itself.

### Updating the vendored copy

`.claude/skills/hallmark` is an unmodified copy of `skills/hallmark` from https://github.com/Nutlope/hallmark (v2.0.0, commit `407fa689f4a276f2fd389208d271d0fef08f5058`, MIT). To update it, replace the folder with a newer `skills/hallmark` and update the commit hash here. Don't edit files inside the folder; put any local changes in this file instead.
