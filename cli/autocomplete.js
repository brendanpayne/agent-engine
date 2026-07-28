// The slash-command picker.
//
// Typing `/` opens a list under the prompt that narrows as you type, the way
// the chat client this CLI is shaped after does it. Tab cycles, Shift-Tab goes
// back, Escape dismisses, Enter sends the line as usual.
//
// Drawing under a live readline prompt is the whole problem here. The rules
// this file follows:
//
//   * The cursor always ends where readline left it. Every draw finishes by
//     moving back up and setting the column explicitly, so readline's own
//     redraw on the next keystroke lands in the right place.
//   * Draws may scroll the terminal — the prompt is usually near the bottom.
//     Moving *relative* to the cursor after writing (rather than restoring a
//     saved absolute position) survives that, because the cursor scrolls with
//     the screen and a saved position does not.
//   * In raw mode a bare LF moves down without returning to column 1, so lines
//     are separated by "\n\r".
//
// It stays out of the way when it cannot draw honestly: no TTY, a wrapped input
// line, or a cursor that is not at the end of the line.

const MAX_ROWS = 7;

function create({ rl, commands, ui, ctx, stream = process.stdout }) {
  let drawnRows = 0;
  let selected = 0;
  let dismissed = false;
  let lastLine = null;

  const enabled = () => Boolean(stream.isTTY) && ctx.settings.autocomplete !== false;
  const columns = () => stream.columns || 80;

  // Candidates come from the store, which can fail — a locked database, a
  // session deleted from under us. This runs inside a keypress listener, where
  // an exception is unhandled and takes the whole REPL down with it, so a
  // failure here means "no suggestions", never a crash while someone is typing.
  function candidates() {
    try {
      return commands.suggest(rl.line, ctx);
    } catch (_) {
      return null;
    }
  }

  // Where the cursor sits on the input line, as a 0-based column.
  const cursorColumn = () => ui.visibleLength(rl.getPrompt()) + rl.cursor;

  const restoreColumn = () => stream.write(`\x1b[${cursorColumn() + 1}G`);

  // Clear from the line below the prompt down. Never touches the prompt line
  // itself, so readline's idea of what is on screen stays true.
  function clear() {
    if (drawnRows === 0) return;
    stream.write("\x1b[1B\r\x1b[J\x1b[1A");
    restoreColumn();
    drawnRows = 0;
  }

  // Called once the line has been submitted: readline has already echoed a
  // newline, so the cursor is sitting on the picker's first row and everything
  // from here down is ours to erase.
  function clearAfterSubmit() {
    if (drawnRows === 0) return;
    stream.write("\x1b[J");
    drawnRows = 0;
  }

  function draw(lines) {
    if (lines.length === 0) return;
    stream.write(`\n\r${lines.join("\n\r")}`);
    stream.write(`\x1b[${lines.length}A`);
    restoreColumn();
    drawnRows = lines.length;
  }

  // The visible window follows the selection, so cycling past the bottom of a
  // long list scrolls it rather than hiding where you are.
  function windowFor(items) {
    if (items.length <= MAX_ROWS) return { start: 0, end: items.length };
    const start = Math.min(
      Math.max(0, selected - Math.floor(MAX_ROWS / 2)),
      items.length - MAX_ROWS,
    );
    return { start, end: start + MAX_ROWS };
  }

  function render(items, token) {
    const max = columns() - 1;
    const { start, end } = windowFor(items);
    const labelWidth = Math.min(
      24,
      Math.max(...items.slice(start, end).map(i => ui.visibleLength(i.label))),
    );

    const rows = items.slice(start, end).map((item, i) => {
      const active = start + i === selected;
      const marker = active ? ui.c.accent("▸") : " ";
      // The typed part is highlighted inside the label, so it is obvious why a
      // fuzzy match is in the list at all.
      const label = highlight(item.label, token, active);
      const padded = label + " ".repeat(Math.max(0, labelWidth - ui.visibleLength(item.label)));
      const hint = item.hint ? ui.c.muted(item.hint) : "";
      const line = `  ${marker} ${padded}  ${hint}`;
      return truncate(line, max);
    });

    const more = items.length - (end - start);
    const footer = [
      `${items.length} match${items.length === 1 ? "" : "es"}`,
      more > 0 ? `+${more} more` : null,
      "Tab cycles",
      "Esc dismisses",
    ].filter(Boolean).join(" · ");
    rows.push(truncate(`    ${ui.c.muted(footer)}`, max));
    return rows;
  }

  function highlight(label, token, active) {
    // Styling an empty segment still emits its escape codes, so each piece is
    // only wrapped when there is something in it.
    const style = s => (s === "" ? "" : (active ? ui.c.bold(s) : s));
    if (!token) return style(label);

    const at = label.toLowerCase().indexOf(token.toLowerCase());
    if (at === -1) return style(label);
    const hit = label.slice(at, at + token.length);
    return style(label.slice(0, at))
      + ui.c.accent(ui.c.bold(hit))
      + style(label.slice(at + token.length));
  }

  function truncate(line, max) {
    if (ui.visibleLength(line) <= max) return line;
    // Cut on the stripped text, then re-clip: slicing a styled string can sever
    // an escape sequence and leak it into the terminal.
    return `${ui.strip(line).slice(0, max - 1)}…`;
  }

  // Recompute and redraw. Every path that changes the line or the selection
  // ends here. `override` keeps a cycling session showing the list it started
  // with — see the Tab handling below.
  function refresh(override) {
    if (!enabled()) return;
    clear();

    if (dismissed) return;
    // Completing into the middle of a line would need the picker to reason
    // about text after the cursor; it does not, so it steps aside instead.
    if (rl.cursor !== rl.line.length) return;

    const result = override || candidates();
    if (!result || result.items.length === 0) return;

    // A wrapped input line breaks the "move up N rows" arithmetic, because the
    // prompt occupies more rows than we counted.
    if (cursorColumn() + 1 >= columns()) return;

    selected = Math.min(selected, result.items.length - 1);
    draw(render(result.items, result.token));
  }

  // Retype the line with the half-typed word swapped for a candidate. rl.write
  // is used rather than assigning rl.line so readline redraws the line itself
  // and its own cursor bookkeeping stays correct.
  function replaceLine(text) {
    clear();
    rl.write(null, { ctrl: true, name: "e" }); // to end of line
    rl.write(null, { ctrl: true, name: "u" }); // kill to start
    rl.write(text);
  }

  // A cycling session: Tab walks the list *and inserts as it goes*, so whatever
  // is highlighted is also what is on the line. Enter then sends the highlighted
  // candidate without the picker having to intercept it — which it cannot do
  // anyway, since readline emits "line" from its own handler before this one
  // ever sees the key.
  //
  // The session pins the list it started from. Recomputing per keystroke would
  // be wrong: once "discord" has been inserted, the line no longer parses as a
  // half-typed value and the candidates would change under the user mid-cycle.
  let cycle = null;

  function onTab(shift) {
    if (!cycle) {
      const result = candidates();
      if (!result || result.items.length === 0) return;
      dismissed = false;

      // If the list is not on screen yet — first Tab on a bare line, or after
      // Escape — show it before committing the user to anything.
      if (drawnRows === 0) {
        selected = 0;
        refresh(result);
        return;
      }
      cycle = {
        items: result.items,
        token: result.token,
        head: rl.line.slice(0, rl.line.length - result.token.length),
        index: -1,
      };
    }

    const count = cycle.items.length;
    // index -1 means the session has not landed anywhere yet: the first step
    // goes to an end of the list, not one place either side of the top.
    if (cycle.index === -1) {
      cycle.index = shift ? count - 1 : 0;
    } else {
      cycle.index = shift
        ? (cycle.index - 1 + count) % count
        : (cycle.index + 1) % count;
    }
    selected = cycle.index;

    const item = cycle.items[cycle.index];
    // One candidate means there is nothing to cycle through, so finish the word
    // with a space and move the picker on to the next argument.
    const done = count === 1;
    replaceLine(`${cycle.head}${item.value}${done ? " " : ""}`);

    const session = cycle;
    if (done) cycle = null;
    lastLine = rl.line;
    refresh(cycle ? { items: session.items, token: session.token } : undefined);
  }

  function onKeypress(_str, key = {}) {
    if (!enabled()) return;

    if (key.name === "tab") {
      onTab(Boolean(key.shift));
      return;
    }

    // Any other key ends the cycling session: the line is no longer the one
    // those candidates were computed against.
    cycle = null;

    if (key.name === "escape") {
      dismissed = true;
      clear();
      return;
    }

    // Submission is cleaned up from the "line" event instead: readline emits it
    // from inside its own keypress handler, which runs before this one, so by
    // the time we get here the rows are already gone.
    if (key.name === "return" || key.name === "enter") {
      dismissed = false;
      selected = 0;
      lastLine = null;
      return;
    }

    // Any edit invalidates the selection and un-dismisses, so typing another
    // character after Escape brings the list back.
    if (rl.line !== lastLine) {
      selected = 0;
      dismissed = false;
      lastLine = rl.line;
    }
    refresh();
  }

  // Last line of defence. Nothing cosmetic is worth interrupting someone
  // mid-sentence, so a failure anywhere in here takes the picker off screen and
  // leaves readline to carry on as if it had never been attached.
  function safeKeypress(str, key) {
    try {
      onKeypress(str, key);
    } catch (_) {
      cycle = null;
      try { clear(); } catch (__) { drawnRows = 0; }
    }
  }

  return {
    attach(input) {
      if (!enabled()) return;
      input.on("keypress", safeKeypress);
    },
    // Anything that prints over the prompt — a reminder, a redraw — has to drop
    // the picker first or it will be left behind as garbage.
    clear,
    // Call this from readline's "line" event, not clear(): the newline has
    // already been echoed, so the cursor is sitting on the picker's first row
    // and moving down again would strand it.
    clearAfterSubmit,
  };
}

module.exports = { create, MAX_ROWS };
