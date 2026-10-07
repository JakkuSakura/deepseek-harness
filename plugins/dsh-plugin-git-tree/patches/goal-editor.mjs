/**
 * Let a goal's objective be edited as multiple lines.
 *
 * The goal bar's editor is an `<input type="text">`, so a goal that spans several
 * lines cannot be edited: an `<input>` value cannot contain newlines, and the HTML
 * spec strips them on the way in. A textarea is the control that holds one.
 *
 * The `type` attribute goes with it, because it is not valid on a textarea.
 */
export default {
  id: 'goal-editor',
  summary: 'the goal objective is edited in a textarea, so multiple lines survive',
  package: '@deepseek-ai/dsh-client-ui-goal',
  file: 'lib/client.js',
  replacements: [
    {
      find: `(0, react_jsx_runtime.jsx)("input", {
\t\t\t\t\t\t\tclassName: GoalBar_module_css_default.objectiveInput,
\t\t\t\t\t\t\ttype: "text",`,
      replace: `(0, react_jsx_runtime.jsx)("textarea", {
\t\t\t\t\t\t\tclassName: GoalBar_module_css_default.objectiveInput,
\t\t\t\t\t\t\trows: 3,`,
    },
    {
      // The class was written for an input, so it pins one line: `height: 26px`
      // clips a textarea to exactly that. A minimum lets it grow to its rows, and
      // the box-sizing and vertical resize are what make it behave like a field
      // someone can actually write a paragraph in.
      find: 'height:26px;color:var(--dsw-alias-label-primary);outline:none;flex:1;padding:0 8px;',
      replace: 'min-height:26px;box-sizing:border-box;resize:vertical;color:var(--dsw-alias-label-primary);outline:none;flex:1;padding:4px 8px;',
    },
  ],
}
