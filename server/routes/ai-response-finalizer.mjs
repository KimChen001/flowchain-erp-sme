export async function finalizeAiResponse({ handler, candidate, state }) {
  const {
    body,
    ctx,
    db,
    startedAt,
    branchStartedAt,
    recordEvent,
    logTiming,
  } = state;
  const result = handler.decorate
    ? await handler.decorate({ candidate, state })
    : {
        ...candidate,
        ...(handler.fastPath ? { fastPath: handler.fastPath } : {}),
        ...(handler.includeUsedWeb === false ? {} : { usedWeb: false }),
        timingMs: Date.now() - startedAt,
        ...(handler.includeExternalMs === false ? {} : { externalMs: 0 }),
        modelMs: handler.modelTiming === "elapsed"
          ? Date.now() - branchStartedAt
          : 0,
      };

  if (handler.afterResult) await handler.afterResult({ result, state });
  const audit = typeof handler.audit === "function"
    ? handler.audit(result, state)
    : handler.audit;
  if (audit) {
    void recordEvent({
      db,
      event: ctx.event,
      repositories: ctx.repositories,
      ...audit,
    });
  }
  const timingBranch = typeof handler.timingBranch === "function"
    ? handler.timingBranch(result, state)
    : handler.timingBranch || handler.id;
  logTiming({
    startedAt,
    branchStartedAt,
    branch: timingBranch,
    body,
    result,
  });
  ctx.send(ctx.res, 200, result);
  return { handled: true, result, handlerId: handler.id };
}
