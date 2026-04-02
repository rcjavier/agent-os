/**
 * Host directory mount backend.
 *
 * Projects a host directory into the VM with symlink escape prevention.
 * All paths are canonicalized and validated to stay within the host root.
 * Read-only by default.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as posixPath from "node:path/posix";
import {
	KernelError,
	type VirtualDirEntry,
	type VirtualFileSystem,
	type VirtualStat,
} from "@secure-exec/core";

export interface HostDirBackendOptions {
	/** Absolute path to the host directory to project into the VM. */
	hostPath: string;
	/** If true (default), write operations throw EROFS. */
	readOnly?: boolean;
}

export interface HostDirBackendMeta {
	hostPath: string;
	readOnly: boolean;
}

export const HOST_DIR_BACKEND_META = Symbol.for(
	"@rivet-dev/agent-os/HostDirBackendMeta",
);

type HostDirVirtualFileSystem = VirtualFileSystem & {
	[HOST_DIR_BACKEND_META]?: HostDirBackendMeta;
};

export function getHostDirBackendMeta(
	driver: VirtualFileSystem,
): HostDirBackendMeta | null {
	const meta = (driver as HostDirVirtualFileSystem)[HOST_DIR_BACKEND_META];
	return meta ?? null;
}

/**
 * Create a VirtualFileSystem that projects a host directory into the VM.
 * Symlink escape and path traversal attacks are blocked by canonicalizing
 * all resolved paths and verifying they remain under `hostPath`.
 */
export function createHostDirBackend(
	options: HostDirBackendOptions,
): VirtualFileSystem {
	const readOnly = options.readOnly ?? true;
	// Canonicalize the host root at creation time
	const canonicalRoot = fsSync.realpathSync(options.hostPath);

	function ensureWithinRoot(hostPath: string, virtualPath: string): void {
		if (
			hostPath !== canonicalRoot &&
			!hostPath.startsWith(`${canonicalRoot}${path.sep}`)
		) {
			throw new KernelError(
				"EACCES",
				`path escapes host directory: ${virtualPath}`,
			);
		}
	}

	function normalizeVirtualPath(p: string): string {
		return posixPath.resolve("/", p);
	}

	function lexicalHostPath(p: string): string {
		const normalized = normalizeVirtualPath(p).replace(/^\/+/, "");
		const joined = path.join(canonicalRoot, normalized);
		ensureWithinRoot(path.resolve(joined), p);
		return joined;
	}

	function hostToVirtualPath(hostPath: string, virtualPath: string): string {
		const resolved = path.resolve(hostPath);
		ensureWithinRoot(resolved, virtualPath);
		const relative = path.relative(canonicalRoot, resolved);
		if (!relative) return "/";
		return `/${relative.split(path.sep).join("/")}`;
	}

	/**
	 * Resolve a virtual path to a host path and validate it stays under root.
	 * Uses realpath for existing paths (catches symlink escapes) and
	 * falls back to lexical resolution for non-existent paths.
	 */
	function resolve(p: string): string {
		const joined = lexicalHostPath(p);

		// For existing paths, canonicalize to catch symlink escapes
		try {
			const real = fsSync.realpathSync(joined);
			ensureWithinRoot(real, p);
			return real;
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "ENOENT") {
				// Path doesn't exist yet — validate the parent instead
				const parentHost = path.dirname(joined);
				try {
					const realParent = fsSync.realpathSync(parentHost);
					ensureWithinRoot(realParent, p);
				} catch (parentErr) {
					const pe = parentErr as NodeJS.ErrnoException;
					if (pe instanceof KernelError) throw pe;
					// Parent doesn't exist either — validate lexically
					ensureWithinRoot(path.resolve(joined), p);
				}
				return joined;
			}
			if (e instanceof KernelError) throw e;
			throw err;
		}
	}

	function resolveNoFollow(p: string): string {
		const joined = lexicalHostPath(p);
		const parentHost = path.dirname(joined);
		try {
			const realParent = fsSync.realpathSync(parentHost);
			ensureWithinRoot(realParent, p);
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "ENOENT") {
				ensureWithinRoot(path.resolve(joined), p);
			} else if (e instanceof KernelError) {
				throw e;
			} else {
				throw err;
			}
		}
		return joined;
	}

	function throwIfReadOnly(): void {
		if (readOnly) {
			throw new KernelError("EROFS", "read-only file system");
		}
	}

	function toVirtualStat(s: fsSync.Stats): VirtualStat {
		return {
			mode: s.mode,
			size: s.size,
			isDirectory: s.isDirectory(),
			isSymbolicLink: s.isSymbolicLink(),
			atimeMs: s.atimeMs,
			mtimeMs: s.mtimeMs,
			ctimeMs: s.ctimeMs,
			birthtimeMs: s.birthtimeMs,
			ino: s.ino,
			nlink: s.nlink,
			uid: s.uid,
			gid: s.gid,
		};
	}

	const backend: HostDirVirtualFileSystem = {
		async readFile(p: string): Promise<Uint8Array> {
			return new Uint8Array(await fs.readFile(resolve(p)));
		},

		async readTextFile(p: string): Promise<string> {
			return fs.readFile(resolve(p), "utf-8");
		},

		async readDir(p: string): Promise<string[]> {
			return fs.readdir(resolve(p));
		},

		async readDirWithTypes(p: string): Promise<VirtualDirEntry[]> {
			const entries = await fs.readdir(resolve(p), {
				withFileTypes: true,
			});
			return entries.map((e) => ({
				name: e.name,
				isDirectory: e.isDirectory(),
				isSymbolicLink: e.isSymbolicLink(),
			}));
		},

		async writeFile(
			p: string,
			content: string | Uint8Array,
		): Promise<void> {
			throwIfReadOnly();
			const hostPath = resolve(p);
			await fs.mkdir(path.dirname(hostPath), { recursive: true });
			await fs.writeFile(hostPath, content);
		},

		async createDir(p: string): Promise<void> {
			throwIfReadOnly();
			await fs.mkdir(resolve(p));
		},

		async mkdir(
			p: string,
			options?: { recursive?: boolean },
		): Promise<void> {
			throwIfReadOnly();
			await fs.mkdir(resolve(p), {
				recursive: options?.recursive ?? true,
			});
		},

		async exists(p: string): Promise<boolean> {
			try {
				await fs.access(resolve(p));
				return true;
			} catch {
				return false;
			}
		},

		async stat(p: string): Promise<VirtualStat> {
			const s = await fs.stat(resolve(p));
			return toVirtualStat(s);
		},

		async removeFile(p: string): Promise<void> {
			throwIfReadOnly();
			await fs.unlink(resolveNoFollow(p));
		},

		async removeDir(p: string): Promise<void> {
			throwIfReadOnly();
			await fs.rmdir(resolve(p));
		},

		async rename(oldPath: string, newPath: string): Promise<void> {
			throwIfReadOnly();
			await fs.mkdir(path.dirname(resolveNoFollow(newPath)), {
				recursive: true,
			});
			await fs.rename(resolveNoFollow(oldPath), resolveNoFollow(newPath));
		},

		async realpath(p: string): Promise<string> {
			return hostToVirtualPath(fsSync.realpathSync(resolveNoFollow(p)), p);
		},

		async symlink(target: string, linkPath: string): Promise<void> {
			throwIfReadOnly();
			const hostLinkPath = resolveNoFollow(linkPath);
			await fs.mkdir(path.dirname(hostLinkPath), { recursive: true });
			const linkVirtualPath = normalizeVirtualPath(linkPath);
			const targetVirtualPath = target.startsWith("/")
				? normalizeVirtualPath(target)
				: normalizeVirtualPath(
						posixPath.resolve(posixPath.dirname(linkVirtualPath), target),
					);
			const hostTargetPath = lexicalHostPath(targetVirtualPath);
			const relativeTarget = path.relative(
				path.dirname(hostLinkPath),
				hostTargetPath,
			);
			await fs.symlink(relativeTarget, hostLinkPath);
		},

		async readlink(p: string): Promise<string> {
			const hostLinkPath = resolveNoFollow(p);
			const linkTarget = await fs.readlink(hostLinkPath);
			return hostToVirtualPath(
				path.resolve(path.dirname(hostLinkPath), linkTarget),
				p,
			);
		},

		async lstat(p: string): Promise<VirtualStat> {
			const s = await fs.lstat(resolveNoFollow(p));
			return toVirtualStat(s);
		},

		async link(oldPath: string, newPath: string): Promise<void> {
			throwIfReadOnly();
			const hostOldPath = resolveNoFollow(oldPath);
			const hostNewPath = resolveNoFollow(newPath);
			await fs.mkdir(path.dirname(hostNewPath), { recursive: true });
			await fs.link(hostOldPath, hostNewPath);
		},

		async chmod(p: string, mode: number): Promise<void> {
			throwIfReadOnly();
			await fs.chmod(resolve(p), mode);
		},

		async chown(p: string, uid: number, gid: number): Promise<void> {
			throwIfReadOnly();
			await fs.chown(resolve(p), uid, gid);
		},

		async utimes(p: string, atime: number, mtime: number): Promise<void> {
			throwIfReadOnly();
			await fs.utimes(resolve(p), atime / 1000, mtime / 1000);
		},

		async truncate(p: string, length: number): Promise<void> {
			throwIfReadOnly();
			await fs.truncate(resolve(p), length);
		},

		async pread(
			p: string,
			offset: number,
			length: number,
		): Promise<Uint8Array> {
			const handle = await fs.open(resolve(p), "r");
			try {
				const buf = new Uint8Array(length);
				const { bytesRead } = await handle.read(buf, 0, length, offset);
				return bytesRead < length ? buf.slice(0, bytesRead) : buf;
			} finally {
				await handle.close();
			}
		},

		async pwrite(
			p: string,
			offset: number,
			data: Uint8Array,
		): Promise<void> {
			throwIfReadOnly();
			const handle = await fs.open(resolve(p), "r+");
			try {
				await handle.write(data, 0, data.length, offset);
			} finally {
				await handle.close();
			}
		},
	};

	backend[HOST_DIR_BACKEND_META] = {
		hostPath: canonicalRoot,
		readOnly,
	};

	return backend;
}
