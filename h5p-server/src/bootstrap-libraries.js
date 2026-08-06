/**
 * Bootstraps the H5P interaction types (libraries) from the H5P Hub.
 *
 * A freshly deployed H5P server has an empty library store. @lumieducation/h5p-server
 * never downloads missing libraries on its own - not when a package is uploaded and
 * not when content is played. The only code path that talks to the Hub is
 * `POST /h5p/ajax?action=library-install&id=<machineName>`, which normally is only
 * triggered by a human clicking "Install" in the editor GUI at /new.
 *
 * This script performs that step automatically so that content referencing a content
 * type can be registered and played right after deployment. It is meant to run once
 * per deployment (see the `h5p-bootstrap` service in docker-compose.yml).
 *
 * It is idempotent: content types that are already installed and up to date are
 * skipped, so re-running it is cheap.
 *
 * Environment variables:
 *   H5P_SERVER_URL            base URL of the H5P server (default http://localhost:3000)
 *   H5P_BOOTSTRAP_LIBRARIES   'all' (default) or a comma separated list of machine names
 *   H5P_BOOTSTRAP_RETRIES     attempts per content type (default 3) - api.h5p.org
 *                             sporadically answers 502 under load
 *   H5P_BOOTSTRAP_UPDATE      'true' to also update outdated content types (default false)
 *   H5P_BOOTSTRAP_WAIT        seconds to wait for the server to become healthy (default 180)
 */

const SERVER_URL = (process.env.H5P_SERVER_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SELECTION = process.env.H5P_BOOTSTRAP_LIBRARIES || 'all';
const RETRIES = Math.max(1, Number(process.env.H5P_BOOTSTRAP_RETRIES || 3));
const UPDATE_OUTDATED = process.env.H5P_BOOTSTRAP_UPDATE === 'true';
const WAIT_SECONDS = Math.max(1, Number(process.env.H5P_BOOTSTRAP_WAIT || 180));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Formats a duration for humans: 45s, 3m20s, 1h04m.
function formatDuration(ms) {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

// Prefixes every log line with the elapsed wall clock time of the whole run, so
// `docker compose logs -f h5p-bootstrap` reads like a progress bar.
const startedAt = Date.now();
const log = (message) => console.log(`[${formatDuration(Date.now() - startedAt).padStart(6)}] ${message}`);
const warn = (message) => console.warn(`[${formatDuration(Date.now() - startedAt).padStart(6)}] ${message}`);

// Waits until the server answers /health with status 'ok'.
async function waitForServer() {
	const deadline = Date.now() + WAIT_SECONDS * 1000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${SERVER_URL}/health`);
			if (response.ok && (await response.json()).status === 'ok') {
				return true;
			}
		} catch {
			// server not up yet
		}
		await sleep(2000);
	}
	return false;
}

// Returns the content types the Hub offers, enriched with the local install state.
async function loadContentTypes() {
	const response = await fetch(`${SERVER_URL}/api/content-types`);
	if (!response.ok) {
		throw new Error(`/api/content-types answered HTTP ${response.status}`);
	}
	const {contentTypes} = await response.json();
	return contentTypes || [];
}

/**
 * Installs one content type, retrying on server side and network errors.
 *
 * @param machineName the content type to install
 * @param progress a `12/53` style position marker for the log output
 * @returns 'installed', 'skipped' (Hub cannot deliver it) or 'failed'
 */
async function installContentType(machineName, progress) {
	const url = `${SERVER_URL}/h5p/ajax?action=library-install&id=${encodeURIComponent(machineName)}&language=en`;
	const label = `${progress} ${machineName}`;
	const itemStartedAt = Date.now();

	// Big content types pull dozens of libraries and can take a while. A heartbeat
	// keeps the log alive so admins can tell "slow" apart from "stuck".
	log(`${label} ...`);
	const heartbeat = setInterval(
		() => log(`${label} ... still downloading (${formatDuration(Date.now() - itemStartedAt)})`),
		15000
	);

	try {
		for (let attempt = 1; attempt <= RETRIES; attempt++) {
			let response;
			let body;
			try {
				response = await fetch(url, {method: 'POST'});
				body = await response.json().catch(() => ({}));
			} catch (error) {
				warn(`${label} attempt ${attempt}/${RETRIES} failed (${error.message})`);
				if (attempt < RETRIES) await sleep(attempt * 2000);
				continue;
			}

			if (response.ok && body.success !== false) {
				log(`${label} OK after ${formatDuration(Date.now() - itemStartedAt)} - ${body.message || 'nothing new'}`);
				return 'installed';
			}

			// The Hub lists content types whose package it does not actually serve
			// (e.g. H5P.TwitterUserFeed answers 404). Retrying does not help.
			if (response.status === 400 || response.status === 404) {
				warn(`${label} SKIPPED - ${body.message || `HTTP ${response.status}`}`);
				return 'skipped';
			}

			warn(`${label} attempt ${attempt}/${RETRIES} failed - ${body.message || `HTTP ${response.status}`}`);
			if (attempt < RETRIES) await sleep(attempt * 2000);
		}

		return 'failed';
	} finally {
		clearInterval(heartbeat);
	}
}

async function bootstrap() {
	log(`H5P server: ${SERVER_URL}`);

	if (!(await waitForServer())) {
		console.error(`[bootstrap] server did not become healthy within ${WAIT_SECONDS}s - aborting`);
		process.exit(1);
	}

	const contentTypes = await loadContentTypes();
	if (contentTypes.length === 0) {
		console.error('[bootstrap] the Hub did not offer any content type - is api.h5p.org reachable?');
		process.exit(1);
	}
	log(`Hub offers ${contentTypes.length} content types`);

	let wanted = contentTypes;
	if (SELECTION !== 'all') {
		const names = SELECTION.split(',').map((name) => name.trim()).filter(Boolean);
		wanted = contentTypes.filter((type) => names.includes(type.machineName));
		const unknown = names.filter((name) => !contentTypes.some((type) => type.machineName === name));
		if (unknown.length > 0) {
			warn(`not offered by the Hub, ignored: ${unknown.join(', ')}`);
		}
	}

	const todo = wanted.filter((type) => {
		if (type.canInstall === false) return false;
		if (!type.installed) return true;
		return UPDATE_OUTDATED && type.isUpToDate === false;
	});

	log(`${wanted.length} selected, ${wanted.length - todo.length} already present, ${todo.length} to install`);
	if (todo.length === 0) {
		log('nothing to do - the H5P server is ready');
		return;
	}
	// Rough upfront number so admins know whether to wait or to grab a coffee.
	// Measured reference: the full catalogue (53 types, 145 libraries) took 1m22s.
	// Heavily network-bound, so this is refined from real timings while running.
	log(`estimated duration: ${formatDuration(todo.length * 2500)} (rough - refined after the first installs)`);

	const counts = {installed: 0, skipped: 0, failed: 0};
	const width = String(todo.length).length;
	const installStartedAt = Date.now();

	for (const [index, type] of todo.entries()) {
		const progress = `[${String(index + 1).padStart(width)}/${todo.length}]`;
		counts[await installContentType(type.machineName, progress)]++;

		const done = index + 1;
		const remaining = todo.length - done;
		if (remaining > 0) {
			const perItem = (Date.now() - installStartedAt) / done;
			log(`   ${done}/${todo.length} done, ${remaining} to go - approx. ${formatDuration(perItem * remaining)} remaining`);
		}
	}

	log(`done in ${formatDuration(Date.now() - startedAt)} - installed: ${counts.installed}, skipped: ${counts.skipped}, failed: ${counts.failed}`);

	// A failure here means the Hub was reachable but did not deliver. That is worth a
	// non-zero exit, so the deployment surfaces it, but the server itself stays usable.
	if (counts.failed > 0) {
		process.exit(2);
	}
}

bootstrap().catch((error) => {
	console.error(`[bootstrap] aborted: ${error.message}`);
	process.exit(1);
});
