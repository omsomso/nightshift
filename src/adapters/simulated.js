// Development-only adapter. This neither calls a model nor verifies real code.
export const simulatedAdapter = {
  async execute(task) {
    return { summary: `[SIMULATED] ${task.title}`, evidence: [`simulated-check:${task.id}`] };
  }
};

export const simulatedReviewer = {
  async review(task, result) {
    return {
      passed: result.evidence.includes(`simulated-check:${task.id}`),
      reason: '[SIMULATED] Demo evidence matched; no real project was verified.'
    };
  }
};
