// Must be imported before anything that loads node:sqlite: drop its ExperimentalWarning so stderr stays quiet.
const emit = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(w?.message ?? w))) return;
  return emit(w, ...rest);
};
