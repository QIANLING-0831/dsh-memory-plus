import MemorySearchEngine from "../lib/index.js";

const snapshot = JSON.parse(process.argv[3]);
const engine = new MemorySearchEngine({
	reflect: { provide() {} },
	sessions: { get: () => undefined },
	sessionQuery: { listSessions: async () => [{ header: snapshot.header }] }
}, { path: process.argv[2] });
try {
	await engine._ensureReady();
	const embed = engine._embed;
	engine._embed = async (texts) => {
		const vectors = await embed(texts);
		const release = new Promise((resolve) => process.once("message", resolve));
		process.send("ready");
		await release;
		return vectors;
	};
	const count = await engine.indexSession(snapshot);
	process.send({ count });
} catch (error) {
	process.send({ error: error.message });
	process.exitCode = 1;
} finally {
	await engine.close();
	process.disconnect();
}
