import { Notice, Plugin, requestUrl, TAbstractFile } from 'obsidian';
import { GitHubClient } from './github';
import { DeviceStore } from './storage';
import { SyncEngine } from './sync';
import { VaultBridge } from './vault';
import { inFolder, safePath, supported } from './paths';
import { connectionConflicts, localPathsOverlap } from './connections';
import { Connection, UserError } from './types';
import { ConnectModal, ExplorerView, PluginSettings, VIEW_TYPE, DiagnosticModal } from './ui';
import { VaultExportService } from './export-service';
import { VaultExportPlan } from './vault-export';
import { VaultExportModal } from './export-ui';

export default class GitHubSyncZev extends Plugin {
  store!: DeviceStore;
  client!: GitHubClient;
  engine!: SyncEngine;
  bridge!: VaultBridge;
  exporter!: VaultExportService;
  secretId = '';
  private ready = false;
  private readonly uploadTimers = new Map<string, number>();
  private lastPoll = 0;
  private statusEl: HTMLElement | null = null;
  private changedTimer: number | null = null;
  private syncAllRunning = false;
  private editingConnections = false;

  async onload(): Promise<void> {
    try {
      let deviceKey: unknown = this.app.loadLocalStorage('repo-relay-zev-device-key');
      if (typeof deviceKey !== 'string' || !/^[a-z0-9-]+$/.test(deviceKey)) {
        deviceKey = crypto.randomUUID();
        this.app.saveLocalStorage('repo-relay-zev-device-key', deviceKey);
      }
      this.secretId = `repo-relay-zev-${String(deviceKey)}`;
      this.store = new DeviceStore(String(deviceKey));
      await this.store.open();
      this.bridge = new VaultBridge(this.app, () => this.store.data.settings.maxFileMB * 1024 * 1024);
      this.client = new GitHubClient(async params => {
        const response = await requestUrl({ ...params, throw: false });
        let json: unknown;
        try { json = response.json; } catch { json = null; }
        return { status: response.status, headers: response.headers, json };
      }, id => this.app.secretStorage.getSecret(id), () => this.store.data.settings.maxFileMB * 1024 * 1024);
      this.engine = new SyncEngine(this.store, this.bridge, this.client, () => this.emit());
      this.exporter = new VaultExportService(this.store, this.client, () => this.emit());
      this.registerView(VIEW_TYPE, leaf => new ExplorerView(leaf, this));
      this.addRibbonIcon('github', 'Open GitHub workspace', () => this.run(() => this.openExplorer()));
      this.addCommand({ id: 'open-workspaces', name: 'Open workspace browser', callback: () => this.run(() => this.openExplorer()) });
      this.addCommand({ id: 'connect-folder', name: 'Open or connect a GitHub folder', callback: () => new ConnectModal(this).open() });
      this.addCommand({ id: 'sync-all', name: 'Sync all connected folders', callback: () => this.run(() => this.syncAll(true)) });
      this.addCommand({ id: 'refresh-all', name: 'Download remote updates', callback: () => this.run(() => this.syncAll(false)) });
      this.addCommand({ id: 'safe-diagnostics', name: 'Show private-data-free diagnostics', callback: () => new DiagnosticModal(this).open() });
      this.addCommand({ id: 'save-full-vault', name: 'Save standalone vault to GitHub', callback: () => new VaultExportModal(this).open() });
      this.addSettingTab(new PluginSettings(this));
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('gsz-statusbar');
      this.statusEl.addEventListener('click', () => this.run(() => this.openExplorer()));
      this.registerEvent(this.app.vault.on('modify', file => this.fileChanged(file)));
      this.registerEvent(this.app.vault.on('create', file => this.fileChanged(file)));
      this.registerEvent(this.app.vault.on('delete', file => this.fileChanged(file)));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { this.fileChanged(file); this.pathChanged(oldPath); }));
      this.registerDomEvent(window, 'online', () => { this.lastPoll = 0; this.emit(); this.backgroundSync(); });
      this.registerDomEvent(window, 'offline', () => this.emit());
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') { this.lastPoll = 0; this.backgroundSync(); }
      });
      this.registerInterval(window.setInterval(() => this.backgroundSync(), 5000));
      this.ready = true;
      this.app.workspace.onLayoutReady(() => {
        if (!this.ready) return;
        this.emit();
        this.backgroundSync();
      });
    } catch (error) {
      this.ready = false;
      this.store?.close();
      this.showError(error);
    }
  }

  onunload(): void {
    this.ready = false;
    this.engine?.stop();
    this.exporter?.stop();
    for (const timer of this.uploadTimers.values()) window.clearTimeout(timer);
    this.uploadTimers.clear();
    if (this.changedTimer !== null) window.clearTimeout(this.changedTimer);
    // Native Markdown tabs stay open. IndexedDB transactions already queued are allowed to finish.
    if (this.store) void this.store.flush().catch(() => undefined).finally(() => this.store.close());
  }

  run(task: () => Promise<unknown>): void { void task().catch(error => this.showError(error)); }

  showError(error: unknown): void {
    new Notice(error instanceof UserError ? error.message : 'The operation could not finish. Local files were kept. Retry or reopen the workspace browser.', 8000);
  }

  storeToken(token: string): void {
    const value = token.trim();
    if (value.length < 20 || value.length > 255 || /\s/.test(value)) throw new UserError('Paste a valid GitHub personal access token.');
    this.app.secretStorage.setSecret(this.secretId, value);
  }

  private fileChanged(file: TAbstractFile): void { this.pathChanged(file.path); }

  private pathChanged(path: string): void {
    if (!this.ready) return;
    for (const mount of Object.values(this.store.data.mounts)) {
      const connection = mount.connection;
      if (!inFolder(path, connection.localPath)) continue;
      const relative = path.slice(connection.localPath.length + 1);
      if (relative && !supported(relative) && path !== connection.localPath) {
        // A folder rename/delete still affects tracked descendants.
        if (!Object.keys(mount.baseline).some(p => inFolder(p, relative))) continue;
      }
      mount.pending = Math.max(1, mount.pending);
      if (this.changedTimer === null) this.changedTimer = window.setTimeout(() => {
        this.changedTimer = null;
        this.run(() => this.store.save());
        this.emit();
      }, 400);
      if (connection.paused || !connection.autoUpload || connection.access !== 'read-write' || this.engine.isRunning(connection.id)) continue;
      const previous = this.uploadTimers.get(connection.id);
      if (previous !== undefined) window.clearTimeout(previous);
      this.uploadTimers.set(connection.id, window.setTimeout(() => {
        this.uploadTimers.delete(connection.id);
        this.run(() => this.syncOne(connection.id, true));
      }, this.store.data.settings.uploadDelaySeconds * 1000));
    }
  }

  private backgroundSync(): void {
    if (!this.ready || this.engine.isStopped() || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    if (Date.now() - this.lastPoll < this.store.data.settings.pollSeconds * 1000) return;
    this.lastPoll = Date.now();
    this.run(() => this.syncAll());
  }

  async syncOne(id: string, upload?: boolean, approval?: string): Promise<void> {
    const mount = this.store.data.mounts[id];
    if (!mount || mount.connection.paused || this.engine.isRunning(id) || this.exporter?.busy || this.editingConnections) return;
    try {
      const { local, writers } = this.connectionIssues(mount.connection);
      const other = local[0] ?? writers[0];
      if (other) throw new UserError(`This workspace overlaps “${other.localPath}”. Review the connected folders in settings.`);
      await this.bridge.flushEditors(mount.connection.localPath);
      if (this.editingConnections || this.store.data.mounts[id] !== mount || this.exporter?.busy) return;
      await this.engine.sync(id, mount.lastSync !== null && (upload ?? mount.connection.autoUpload), approval);
    } catch (error) {
      this.engine.statuses.set(id, { phase: 'error', message: error instanceof UserError ? error.message : 'Could not prepare the local workspace. Open the workspace and retry.' });
    }
    this.emit();
  }

  async syncAll(upload?: boolean): Promise<void> {
    if (this.syncAllRunning || this.exporter?.busy) return;
    this.syncAllRunning = true;
    try { for (const id of Object.keys(this.store.data.mounts)) { if (!this.ready) break; await this.syncOne(id, upload); } }
    finally { this.syncAllRunning = false; }
  }

  savedConnections(): Connection[] {
    return Object.values(this.store.data.mounts).map(mount => mount.connection);
  }

  connectionIssues(connection: Connection): ReturnType<typeof connectionConflicts> {
    this.bridge.validateRoot(connection.localPath);
    safePath(connection.remotePath, true);
    return connectionConflicts(connection, this.savedConnections());
  }

  unusedFolder(repo: string): string | null {
    const saved = this.savedConnections().map(connection => connection.localPath);
    const occupied = new Set(this.app.vault.getRoot().children.map(file => file.name.normalize('NFC').toLowerCase()));
    for (let index = 1; index <= 1000; index++) {
      const path = `GitHub - ${repo}${index === 1 ? '' : ` - ${index}`}`;
      try { this.bridge.validateRoot(path); } catch { continue; }
      if (!occupied.has(path.normalize('NFC').toLowerCase()) && !saved.some(root => localPathsOverlap(root, path))) return path;
    }
    return null;
  }

  private async editConnections(task: () => Promise<void>): Promise<void> {
    if (this.editingConnections) throw new UserError('Wait for the current connection change to finish.');
    this.editingConnections = true;
    try { await task(); }
    finally { this.editingConnections = false; }
  }

  async connect(connection: Connection, transferFrom: string[] = []): Promise<void> {
    await this.editConnections(async () => {
      const verify = (): Connection[] => {
        const { local, writers } = this.connectionIssues(connection);
        if (local.length || JSON.stringify(writers.map(writer => writer.id).sort()) !== JSON.stringify([...transferFrom].sort())) {
          throw new UserError('The existing connections changed. Preview this folder again.');
        }
        if (writers.some(writer => this.engine.isRunning(writer.id) || this.store.data.mounts[writer.id]?.inFlight)) {
          throw new UserError('An existing workspace has an active or unfinished upload. Let it finish or sync it before transferring upload access.');
        }
        return writers;
      };
      verify();
      await this.bridge.ensureFolder(connection.localPath);
      await this.engine.add(connection, verify());
    });
    await this.openExplorer(connection.id);
    await this.syncOne(connection.id, false);
  }

  async updateConnection(id: string, change: Partial<Pick<Connection, 'autoUpload' | 'paused' | 'access'>>): Promise<void> {
    await this.editConnections(async () => {
      const mount = this.store.data.mounts[id];
      if (!mount) throw new UserError('This workspace was disconnected.');
      if (this.engine.isRunning(id)) throw new UserError('Wait for the current sync to finish before changing this connection.');
      const previous = mount.connection;
      const updated = { ...previous, ...change };
      if (updated.access === 'read-only') updated.autoUpload = false;
      if (previous.access !== updated.access && mount.inFlight) throw new UserError('Sync this workspace to recover its unfinished upload before changing access.');
      if (change.access === 'read-write') {
        const { writers } = this.connectionIssues(updated);
        if (writers.length) throw new UserError(`Upload access is already assigned to “${writers[0]!.localPath}”. Change that workspace to read-only first.`);
      }
      mount.connection = updated;
      try { await this.store.save(); }
      catch (error) { mount.connection = previous; throw error; }
      this.emit();
    });
  }

  async disconnect(id: string): Promise<void> {
    await this.editConnections(() => this.engine.disconnect(id));
  }

  async saveVault(connectionId: string, plan: VaultExportPlan): Promise<void> {
    const mount = this.store.data.mounts[connectionId];
    if (!mount) throw new UserError('Select an existing writable repository connection.');
    if (this.syncAllRunning || Object.keys(this.store.data.mounts).some(id => this.engine.isRunning(id))) throw new UserError('Wait for folder sync to finish, then save the vault.');
    await this.exporter.publish(mount.connection, plan);
  }

  async openExplorer(connectionId?: string): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const next = this.app.workspace.getLeftLeaf(false);
      if (!next) throw new UserError('Cannot open a workspace pane.');
      leaf = next;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (connectionId && leaf.view instanceof ExplorerView) leaf.view.revealConnection(connectionId);
  }

  emit(): void {
    if (!this.ready) return;
    let pending = 0, conflicts = 0, syncing = false, errors = 0;
    for (const mount of Object.values(this.store.data.mounts)) {
      pending += mount.pending;
      conflicts += Object.keys(mount.conflicts).length;
      syncing ||= this.engine.isRunning(mount.connection.id);
      errors += this.engine.status(mount.connection.id).phase === 'error' ? 1 : 0;
    }
    const summary = this.exporter?.busy ? 'Saving vault…' : syncing ? 'Syncing…' : conflicts ? `${conflicts} conflicts` : errors ? 'Needs attention' : pending ? `${pending} pending` : 'Ready';
    this.statusEl?.setText(`GitHub · ${summary}`);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof ExplorerView) leaf.view.render();
  }
}
