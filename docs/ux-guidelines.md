# Interface copy and visual guidelines

These rules govern the site's own words and styling: templates in `scripts/build-site.js`, renderer labels in `scripts/minutes.js`, and `src/static/style.css`. Summary text comes from the summarizer under `docs/gemini-prompt.md` and is not rewritten by the site.

## Who reads this

Laurel, Maryland residents who want to know quickly whether anything important or unusual happened at a council meeting. Most arrive from a shared link on a phone, so a reader may know nothing about the site.

## Copy rules

- **Say what something is in plain words.** Name the thing a reader will recognize ("Watch on YouTube"), not how the system works ("source recording").
- **Don't describe the interface.** Avoid lines like "Browse summaries by date and follow each one back to its recording." The layout already shows that.
- **Cut labels that repeat what's next to them.** No eyebrow labels above headings, no counts nobody asked for, no taglines restating the heading. A date that is already in the breadcrumb and title doesn't need a third mention.
- **Name the place.** There are many towns called Laurel. Use "Laurel, Maryland" in page headings and descriptions and "Laurel, MD" where space is tight (site name, browser title). "City of Laurel" is fine once the page has already said Maryland.
- **Sentence case, no all-caps labels.**
- **Links say where they go.** "See the full agenda item ↓", "See why it was flagged ↑". Arrows are used only when they show direction on the page or that a link opens another site (↗).
- **One action, one name.** If it's "Watch on YouTube" in one place, it's "Watch on YouTube" everywhere.
- **Empty states tell the reader what to expect.** "A summary appears here the morning after each council meeting," not "Content will appear here when available."
- **One short AI notice, in the footer.** State the fact and the limit plainly: "Written by AI from meeting captions, so it can contain mistakes. Not an official City of Laurel record." Don't repeat disclaimers across the page.
- **Dates read naturally:** "November 9, 2026". The ISO date stays in the `datetime` attribute.

## Visual rules

- **Single reading column**, ordered by what a resident needs first: At a glance, Worth a closer look, section links, decisions, agenda items, public comment, action items, then reference material (attendance, transcript limitations) in a grey box at the end.
- **Color carries meaning, not decoration.** One accent blue for links, navy for text and header, a yellow mark beside section headings and under the header. Other colors appear only where they mean something:
  - vote results: green (passed), red (failed), amber (result not stated); colored from the recorded result wording only, never from vote counts;
  - call-out types: red (Look closer), teal (Resident impact), purple (Open question), shown as a side rule and label text, not a filled background.
- **Structure comes from borders and dividers, not separate tinted cards.** Each section is one bordered list with rules between rows; header rows inside a box are separated by a line.
- **Make long text scannable without rewriting it.** Agenda paragraphs are split into one bullet per sentence, dollar amounts are bold, and each agenda item shows its kind (Spending, Ordinance, Resolution, Public comment, Reports) and the recorded vote result.
- **Avoid both extremes we've tried.** Dense multi-column grids were unreadable; saturated full-color cards on every element felt loud and childish. Aim for calm and clear, with color reserved for what deserves attention.
- **Quality floor:** works at 390px phone width with no sideways scrolling, visible keyboard focus, respects reduced motion.
