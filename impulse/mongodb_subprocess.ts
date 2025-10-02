/**
 * MongoDB Subprocess Manager
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Manages a local MongoDB instance as a subprocess for development/testing.
 *
 * @license MIT
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

export interface MongoSubprocessConfig {
	enabled: boolean;
	mongodPath?: string;
	dbPath?: string;
	port?: number;
	logPath?: string;
	wiredTigerCacheSizeGB?: number;
}

interface SubprocessConfig extends Required<MongoSubprocessConfig> {}

class MongoDBSubprocess {
	private process: ChildProcess | null = null;
	private config: SubprocessConfig;
	private isRunning: boolean = false;
	private startupPromise: Promise<void> | null = null;

	constructor(config: MongoSubprocessConfig) {
		this.config = {
			mongodPath: config.mongodPath || 'mongod',
			dbPath: config.dbPath || path.join(process.cwd(), '.mongodb-data'),
			port: config.port || 27017,
			logPath: config.logPath || path.join(process.cwd(), 'logs', 'mongodb.log'),
			enabled: config.enabled,
		};
	}

	async start(): Promise<void> {
		if (!this.config.enabled) {
			return;
		}

		if (this.startupPromise) {
			return this.startupPromise;
		}

		this.startupPromise = this._start();
		return this.startupPromise;
	}

	private async _start(): Promise<void> {
		if (this.isRunning) {
			return;
		}

		await this.checkPortAvailable(this.config.port!);

		if (!fs.existsSync(this.config.dbPath!)) {
			fs.mkdirSync(this.config.dbPath!, { recursive: true });
		}

		const logDir = path.dirname(this.config.logPath!);
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}

		const args = [
			'--dbpath', this.config.dbPath!,
			'--port', String(this.config.port),
			'--logpath', this.config.logPath!,
			'--bind_ip', '127.0.0.1',
		];

		if (this.config.wiredTigerCacheSizeGB !== undefined) {
			args.push('--wiredTigerCacheSizeGB', String(this.config.wiredTigerCacheSizeGB));
		}

		return new Promise((resolve, reject) => {
			this.process = spawn(this.config.mongodPath!, args, {
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let startupTimeout: NodeJS.Timeout;
			let resolved = false;

			const cleanup = () => {
				if (startupTimeout) clearTimeout(startupTimeout);
			};

			const doResolve = () => {
				if (resolved) return;
				resolved = true;
				cleanup();
				this.isRunning = true;
				resolve();
			};

			const doReject = (error: Error) => {
				if (resolved) return;
				resolved = true;
				cleanup();
				this.stop();
				reject(error);
			};

			this.process.stdout?.on('data', (data: Buffer) => {
				const output = data.toString();
				if (output.includes('Waiting for connections') || output.includes('waiting for connections')) {
					doResolve();
				}
			});

			this.process.stderr?.on('data', (data: Buffer) => {
				const output = data.toString();
				if (output.includes('Waiting for connections') || output.includes('waiting for connections')) {
					doResolve();
				}
			});

			this.process.on('error', (err: Error) => {
				doReject(new Error(`Failed to start MongoDB subprocess: ${err.message}`));
			});

			this.process.on('exit', (code: number | null) => {
				this.isRunning = false;
				this.process = null;
				if (!resolved) {
					doReject(new Error(`MongoDB subprocess exited with code ${code} before starting`));
				}
			});

			startupTimeout = setTimeout(() => {
				doReject(new Error('MongoDB subprocess startup timeout (30s)'));
			}, 30000);
		});
	}

	async stop(): Promise<void> {
		if (!this.process || !this.isRunning) {
			return;
		}

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				if (this.process) {
					this.process.kill('SIGKILL');
				}
				resolve();
			}, 5000);

			this.process!.once('exit', () => {
				clearTimeout(timeout);
				this.isRunning = false;
				this.process = null;
				this.startupPromise = null;
				resolve();
			});

			this.process!.kill('SIGTERM');
		});
	}

	getConnectionUri(): string {
		return `mongodb://127.0.0.1:${this.config.port}`;
	}

	isProcessRunning(): boolean {
		return this.isRunning;
	}

	private async checkPortAvailable(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = net.createServer();
			
			server.once('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EADDRINUSE') {
					reject(new Error(`Port ${port} is already in use. Cannot start MongoDB subprocess.`));
				} else {
					reject(new Error(`Port check failed: ${err.message}`));
				}
			});

			server.once('listening', () => {
				server.close(() => {
					resolve();
				});
			});

			server.listen(port, '127.0.0.1');
		});
	}
}

export default MongoDBSubprocess;
