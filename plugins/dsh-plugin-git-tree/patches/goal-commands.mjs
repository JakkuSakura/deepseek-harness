/**
 * Remove `/goal edit`, and only `/goal edit`.
 *
 * The command advertised six paths. Five remain: an objective, `clear`, `pause`,
 * `resume`, and showing the current goal. Objectives can no longer be rewritten in
 * place — clear the goal and set another.
 *
 * `edit` is **refused** rather than reinterpreted. The parser's fall-through treats
 * unrecognised input as an *objective*, so deleting its branches alone would have turned
 * `/goal edit something` into a goal about editing something. The refusal takes the seat
 * of the old `invalid-edit` case, which the new grammar cannot produce.
 *
 * The usage line, the input hint and the two messages that pointed at `/goal edit` are
 * narrowed to match. Advice naming a command that does not exist is how the
 * exhausted-rounds message failed earlier in this same session.
 */
export default {
  id: 'goal-commands',
  summary: '/goal edit is removed and refused; clear, pause and resume remain',
  package: '@deepseek-ai/dsh-command-goal',
  file: 'lib/index.js',
  replacements: [
    {
      find: 'const USAGE = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";',
      replace: '\tconst USAGE = "Usage: /goal [<objective>|clear|pause|resume]";',
    },
    {
      find: '\t\t\thint: "[<objective>|clear|edit <objective>|pause|resume]",',
      replace: '\t\t\thint: "[<objective>|clear|pause|resume]",',
    },
    {
      find: '\tconst control = input.toLowerCase();\n\tif (control === "clear") return { kind: "clear" };\n\tif (control === "pause") return { kind: "pause" };\n\tif (control === "resume") return { kind: "resume" };\n\tif (control === "edit") return { kind: "invalid-edit" };\n\tif (/^edit(?=\\s)/iu.test(input)) return {\n\t\tkind: "edit",\n\t\tobjective: input.slice(4).trim()\n\t};\n\treturn {\n\t\tkind: "create",\n\t\tobjective: input\n\t};',
      replace: '\tconst control = input.toLowerCase();\n\tif (control === "clear") return { kind: "clear" };\n\tif (control === "pause") return { kind: "pause" };\n\tif (control === "resume") return { kind: "resume" };\n\t// `edit` is the one verb that is gone, and it is *refused* rather than reinterpreted:\n\t// the fall-through below treats anything unrecognised as an objective, so deleting\n\t// these lines alone would have created a goal about editing.\n\tif (control === "edit" || /^edit(?=\\s)/iu.test(input)) return { kind: "removed" };\n\treturn {\n\t\tkind: "create",\n\t\tobjective: input\n\t};',
    },
    {
      find: '\t\ttext: "Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>."',
      replace: '\t\t\ttext: "Attachments only accompany a goal objective: /goal <objective>."',
    },
    {
      find: '\t\t\t\t\ttext: `A goal is already ${phaseLabel(current.phase)}. Use /goal edit <objective> to change it or /goal clear before replacing it.`',
      replace: '\t\t\t\t\ttext: `A goal is already ${phaseLabel(current.phase)}. Use /goal clear before replacing it.`',
    },
    {
      find: '\t\t\tcase "invalid-edit": return {\n\t\t\t\tkind: "error",\n\t\t\t\ttext: `Goal editing requires a replacement objective.\\n${USAGE}`\n\t\t\t};',
      replace: '\t\t\tcase "removed": return {\n\t\t\t\tkind: "error",\n\t\t\t\ttext: `Goal objectives cannot be edited. ${USAGE}`\n\t\t\t};',
    }
  ],
}
