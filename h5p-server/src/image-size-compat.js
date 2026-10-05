/**
 * image-size 1.x -> 2.x compatibility layer for @lumieducation/h5p-server
 *
 * image-size < 2.0.3 is affected by CVE-2025-71329 and CVE-2025-71330, so the
 * project pins 2.x via an npm override. image-size 2.x only accepts a buffer,
 * while H5PEditor still calls it the 1.x way with the temp file path of the upload
 * (express-fileupload runs with useTempFiles, so file.data is empty). Without this
 * layer every image upload in the editor would be rejected as corrupt.
 *
 * This module has to be imported before '@lumieducation/h5p-server': it replaces
 * the cached exports of image-size, so the require() inside H5PEditor gets the
 * wrapper that reads the file header and hands a buffer to image-size.
 */

import {createRequire} from 'module';
import {closeSync, openSync, readSync} from 'fs';

// Same chunk size image-size 1.x and imageSizeFromFile() of 2.x read from disk
const MAX_HEADER_SIZE = 512 * 1024;

// Resolve image-size from the point of view of @lumieducation/h5p-server, so the
// very module instance it requires is patched
const require = createRequire(import.meta.url);
const h5pRequire = createRequire(require.resolve('@lumieducation/h5p-server'));
const imageSizePath = h5pRequire.resolve('image-size');
const original = h5pRequire('image-size');

function readHeader(filePath) {
	const fd = openSync(filePath, 'r');
	try {
		const buffer = Buffer.alloc(MAX_HEADER_SIZE);
		const bytesRead = readSync(fd, buffer, 0, MAX_HEADER_SIZE, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		closeSync(fd);
	}
}

function imageSize(input) {
	return original.imageSize(typeof input === 'string' ? readHeader(input) : input);
}

// H5P never needs these formats; their parsers were the subject of the CVEs above,
// so they stay switched off as defence in depth
original.disableTypes(['icns', 'jxl', 'jxl-stream', 'heif']);

h5pRequire.cache[imageSizePath].exports = {
	__esModule: true,
	default: imageSize,
	imageSize,
	disableTypes: original.disableTypes,
	types: original.types
};

export default imageSize;
