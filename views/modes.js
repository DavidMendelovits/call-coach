// Coach styles. Selling is the sales coach. Learning coaches ME to keep asking good questions
// when the other person knows more. The app, the Scorecard and the shared recap read their labels here.
(() => {
  const MODES = {
    sales: {
      name: "Selling",
      phases: ["opener", "rapport", "discovery", "pitch", "objection", "closing", "wrap-up"],
      care: "They care about", loose: "Loose ends", covered: "Covered", misses: "Misses",
      objections: "Objections", objectionsEmpty: "No pushback on this call.",
      outcome: { handled: "Handled", partly: "Partly", not_handled: "Not handled" },
      notes: "CRM notes", email: "Follow-up email",
      recapParts: "summary, goals, objections, next step and a follow-up email",
    },
    learning: {
      name: "Learning",
      phases: ["orient", "explain", "probe", "example", "apply", "recap"],
      care: "Core idea", loose: "Not asked about yet", covered: "Done so far", misses: "Missed questions",
      objections: "Questions you asked", objectionsEmpty: "No questions from you were found on this call.",
      outcome: { handled: "Answered", partly: "Partly", not_handled: "Left open" },
      notes: "What you learned", email: "Thank-you note",
      recapParts: "summary, what you learned, the questions you asked and missed, and a thank-you note",
    },
  };
  window.CoachModes = { MODES, get: (m) => MODES[m] || MODES.sales, ok: (m) => (MODES[m] ? m : "sales") };
})();
