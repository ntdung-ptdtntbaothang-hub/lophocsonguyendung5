import { Task, Submission, Game, GameResult, Student } from '../types';

/**
 * Multi-Layer Real-Time Cross-Device Cloud Synchronization Service
 *
 * Layer 1: Instant Local Cross-Tab Sync (BroadcastChannel) for 0ms same-machine sync.
 * Layer 2: Bytebin Cloud Blob Store (https://bytebin.lucko.me) for unlimited-size fileData (.docx, .pdf, .png, .pptx) with full CORS and zero rate limits.
 * Layer 3: Multi-Topic Ntfy Real-Time Stream (SSE + Smart Polling + Automatic Failover) so submissions never get rate-limited (HTTP 429).
 */
export const PRIMARY_SUB_TOPIC = 'lhs_nguyenthidung_subs_v8';
export const BACKUP_SUB_TOPIC = 'lhs_nguyenthidung_subs_bak_v8';
export const LEGACY_CLOUD_TOPIC = 'lhs_nguyenthidung_thpt_cloud_v5';
export const NTFY_BASE = 'https://ntfy.sh';
export const BYTEBIN_BASE = 'https://bytebin.lucko.me';

export interface CloudSyncCallbacks {
  onTaskUpsert: (task: Task) => void;
  onTaskDelete: (taskId: string) => void;
  onSubmissionUpsert: (submission: Submission, associatedTask?: Task) => void;
  onSubmissionDelete: (submissionId: string) => void;
  onGameUpsert: (game: Game) => void;
  onGameDelete: (gameId: string) => void;
  onGameResultAdd: (result: GameResult) => void;
  onStudentUpsert: (student: Student) => void;
}

export interface CloudEnvelope {
  kind:
    | 'TASK_UPSERT'
    | 'TASK_DELETE'
    | 'SUBMISSION_META'
    | 'SUBMISSION_UPDATE'
    | 'SUBMISSION_DELETE'
    | 'SUBMISSION_FILE_URL'
    | 'GAME_UPSERT'
    | 'GAME_DELETE'
    | 'GAME_RESULT_ADD'
    | 'STUDENT_UPSERT';
  clientId: string;
  ts: number;
  task?: Task;
  taskId?: string;
  submission?: Submission;
  submissionId?: string;
  fileUrl?: string;
  bytebinKey?: string;
  game?: Game;
  gameId?: string;
  gameResult?: GameResult;
  student?: Student;
}

class CloudSyncService {
  private clientId: string;
  private processedMessageIds: Set<string> = new Set();
  private fetchedRemoteUrls: Set<string> = new Set();
  private remoteUrlBySubId: Map<string, string> = new Map();
  private eventSources: EventSource[] = [];
  private broadcastChannel: BroadcastChannel | null = null;
  private callbacks: CloudSyncCallbacks | null = null;
  private isPolling = false;
  private lastPollTimestamp = 0;

  constructor() {
    this.clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  public init(callbacks: CloudSyncCallbacks): void {
    this.callbacks = callbacks;
    if (typeof window === 'undefined') return;

    // 1. Setup Instant Cross-Tab BroadcastChannel (0ms sync on same PC)
    this.initBroadcastChannel();

    // 2. Immediately pull all cached cloud events (force = true on initial load)
    this.pollCloudMessages(true);

    // 3. Start live Server-Sent Events (SSE) streams for sub-second updates
    this.startLiveStreams();

    // 4. Throttled re-sync when browser tab regains focus or visibility
    const onVisible = () => {
      if (Date.now() - this.lastPollTimestamp > 8000) {
        this.pollCloudMessages(false);
      }
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        onVisible();
      }
    });
  }

  private initBroadcastChannel(): void {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    try {
      this.broadcastChannel = new BroadcastChannel('lhs_instant_sync_v8');
      this.broadcastChannel.onmessage = (evt) => {
        if (evt.data && evt.data.kind) {
          this.applyEnvelope(evt.data as CloudEnvelope);
        }
      };
    } catch {
      // ignore if BroadcastChannel is unsupported
    }
  }

  private broadcastLocalTab(env: CloudEnvelope): void {
    try {
      this.broadcastChannel?.postMessage(env);
    } catch {
      // ignore
    }
  }

  private startLiveStreams(): void {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    try {
      this.eventSources.forEach((es) => es.close());
      this.eventSources = [];

      // Listen to both primary v8 submission channel and v5 legacy channel
      const topics = [PRIMARY_SUB_TOPIC, LEGACY_CLOUD_TOPIC];
      for (const topic of topics) {
        const sseUrl = `${NTFY_BASE}/${topic}/sse?since=all`;
        const es = new EventSource(sseUrl);
        es.onmessage = (evt) => {
          if (!evt.data) return;
          try {
            const msg = JSON.parse(evt.data);
            this.handleNtfyMessage(msg);
          } catch {
            // ignore
          }
        };
        this.eventSources.push(es);
      }
    } catch (e) {
      console.warn('SSE stream fallback to polling:', e);
    }
  }

  public async pollCloudMessages(force = false): Promise<boolean> {
    if (this.isPolling) return false;
    // Prevent rapid polling that could trigger rate limits unless forced by user button
    if (!force && Date.now() - this.lastPollTimestamp < 10000) {
      return true;
    }

    this.isPolling = true;
    this.lastPollTimestamp = Date.now();

    try {
      const topics = [PRIMARY_SUB_TOPIC, BACKUP_SUB_TOPIC, LEGACY_CLOUD_TOPIC];
      await Promise.all(
        topics.map(async (topic) => {
          try {
            const res = await fetch(`${NTFY_BASE}/${topic}/json?poll=1&since=all`, {
              cache: 'no-store',
            });
            if (!res.ok) return;
            const text = await res.text();
            if (!text || !text.trim()) return;

            const lines = text.trim().split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                await this.handleNtfyMessage(msg);
              } catch {
                // ignore malformed line
              }
            }
          } catch {
            // ignore topic fetch error
          }
        })
      );
      return true;
    } finally {
      this.isPolling = false;
    }
  }

  private async handleNtfyMessage(msg: any): Promise<void> {
    if (!msg || !msg.id) return;
    if (msg.event && msg.event !== 'message') return;

    // Legacy file attachment handling
    if (msg.attachment && msg.attachment.url) {
      const attUrl: string = msg.attachment.url;
      const attName: string = msg.attachment.name || '';
      if (attName.startsWith('sub_') && attName.endsWith('.json')) {
        const subId = attName.replace(/^sub_/, '').replace(/\.json$/, '');
        this.remoteUrlBySubId.set(subId, attUrl);
      }
      if (!this.fetchedRemoteUrls.has(attUrl)) {
        this.fetchedRemoteUrls.add(attUrl);
        this.fetchAndApplyRemotePayload(attUrl).catch(() => {});
      }
      return;
    }

    if (this.processedMessageIds.has(msg.id)) return;
    this.processedMessageIds.add(msg.id);

    if (!msg.message || typeof msg.message !== 'string') return;
    if (!msg.message.startsWith('{')) return;

    try {
      const env: CloudEnvelope = JSON.parse(msg.message);
      this.applyEnvelope(env);
    } catch {
      // ignore non-envelope messages
    }
  }

  private applyEnvelope(env: CloudEnvelope): void {
    if (!env || !env.kind || !this.callbacks) return;

    switch (env.kind) {
      case 'TASK_UPSERT':
        if (env.task && env.task.id) {
          this.callbacks.onTaskUpsert(env.task);
        }
        break;

      case 'TASK_DELETE':
        if (env.taskId) {
          this.callbacks.onTaskDelete(env.taskId);
        }
        break;

      case 'SUBMISSION_META':
      case 'SUBMISSION_UPDATE':
        if (env.task && env.task.id) {
          this.callbacks.onTaskUpsert(env.task);
        }
        if (env.submission && env.submission.id) {
          this.callbacks.onSubmissionUpsert(env.submission, env.task);

          const bytebinUrl = env.bytebinKey ? `${BYTEBIN_BASE}/${env.bytebinKey}` : undefined;
          const fileUrl = bytebinUrl || env.fileUrl || this.remoteUrlBySubId.get(env.submission.id);

          if (fileUrl) {
            this.remoteUrlBySubId.set(env.submission.id, fileUrl);
            if (!env.submission.fileData && !this.fetchedRemoteUrls.has(fileUrl)) {
              this.fetchedRemoteUrls.add(fileUrl);
              this.fetchAndApplyRemotePayload(fileUrl).catch(() => {});
            }
          }
        }
        break;

      case 'SUBMISSION_FILE_URL':
        if (env.submissionId && env.fileUrl) {
          this.remoteUrlBySubId.set(env.submissionId, env.fileUrl);
          if (!this.fetchedRemoteUrls.has(env.fileUrl)) {
            this.fetchedRemoteUrls.add(env.fileUrl);
            this.fetchAndApplyRemotePayload(env.fileUrl).catch(() => {});
          }
        }
        break;

      case 'SUBMISSION_DELETE':
        if (env.submissionId) {
          this.callbacks.onSubmissionDelete(env.submissionId);
        }
        break;

      case 'GAME_UPSERT':
        if (env.game && env.game.id) {
          this.callbacks.onGameUpsert(env.game);
        }
        break;

      case 'GAME_DELETE':
        if (env.gameId) {
          this.callbacks.onGameDelete(env.gameId);
        }
        break;

      case 'GAME_RESULT_ADD':
        if (env.gameResult && env.gameResult.id) {
          this.callbacks.onGameResultAdd(env.gameResult);
        }
        break;

      case 'STUDENT_UPSERT':
        if (env.student && env.student.id) {
          this.callbacks.onStudentUpsert(env.student);
        }
        break;
    }
  }

  private async fetchAndApplyRemotePayload(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.task && data.task.id && this.callbacks) {
        this.callbacks.onTaskUpsert(data.task);
      }
      if (data && data.submission && data.submission.id && this.callbacks) {
        this.callbacks.onSubmissionUpsert(data.submission, data.task);
      }
    } catch {
      // ignore remote payload fetch errors
    }
  }

  private async postToTopicWithRetry(topic: string, bodyStr: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${NTFY_BASE}/${topic}`, {
          method: 'POST',
          body: bodyStr,
        });
        if (res.ok) return true;
      } catch {
        // retry after short delay
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    return false;
  }

  private async postEnvelope(
    env: Omit<CloudEnvelope, 'clientId' | 'ts'>,
    isCriticalSubmission = false
  ): Promise<boolean> {
    const fullEnv: CloudEnvelope = {
      ...env,
      clientId: this.clientId,
      ts: Date.now(),
    };

    // 1. Broadcast immediately to any open tabs on the same computer
    this.broadcastLocalTab(fullEnv);

    const bodyStr = JSON.stringify(fullEnv);

    if (isCriticalSubmission) {
      // Send to Primary v8 topic AND Legacy v5 topic so all versions of the app receive it immediately
      const [primaryOk, legacyOk] = await Promise.all([
        this.postToTopicWithRetry(PRIMARY_SUB_TOPIC, bodyStr),
        this.postToTopicWithRetry(LEGACY_CLOUD_TOPIC, bodyStr),
      ]);
      if (primaryOk || legacyOk) return true;

      // Failover to backup topic if primary was rate-limited
      return this.postToTopicWithRetry(BACKUP_SUB_TOPIC, bodyStr);
    }

    // Standard task/game/student update
    return this.postToTopicWithRetry(PRIMARY_SUB_TOPIC, bodyStr);
  }

  public async publishTask(task: Task): Promise<boolean> {
    return this.postEnvelope({
      kind: 'TASK_UPSERT',
      task,
    });
  }

  public async publishTaskDelete(taskId: string): Promise<boolean> {
    return this.postEnvelope({
      kind: 'TASK_DELETE',
      taskId,
    });
  }

  /**
   * Publishes a student submission with multi-layer delivery guarantee:
   * 1. Broadcasts full submission (with fileData) via BroadcastChannel for 0ms same-device sync.
   * 2. Uploads full submission + fileData (.docx, .pdf, .png, etc.) to Bytebin Cloud Storage (zero rate limit, full CORS).
   * 3. Publishes compact (< 600 bytes) SUBMISSION_META envelope with bytebinKey to Ntfy topics with automatic failover.
   */
  public async publishSubmission(submission: Submission, associatedTask?: Task): Promise<boolean> {
    // Immediately broadcast full submission with fileData to local tabs on the same PC
    this.broadcastLocalTab({
      kind: 'SUBMISSION_META',
      clientId: this.clientId,
      ts: Date.now(),
      submission,
      task: associatedTask,
    });

    // Upload full payload (including fileData) to Bytebin Cloud Blob Store
    let bytebinKey: string | undefined;
    if (submission.fileData && submission.fileData.length >= 1000) {
      try {
        const bbRes = await fetch(`${BYTEBIN_BASE}/post`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            submission,
            task: associatedTask,
            ts: Date.now(),
          }),
        });
        if (bbRes.ok) {
          const bbJson = await bbRes.json();
          if (bbJson && bbJson.key) {
            bytebinKey = bbJson.key;
          }
        }
      } catch (e) {
        console.warn('Bytebin upload fallback:', e);
      }
    }

    const metaSub: Submission = {
      ...submission,
      fileData:
        submission.fileData && submission.fileData.length < 1000
          ? submission.fileData
          : undefined,
    };

    const compactTask: Task | undefined = associatedTask
      ? {
          ...associatedTask,
          requirements: (associatedTask.requirements || '').slice(0, 220),
          instructions: (associatedTask.instructions || '').slice(0, 220),
        }
      : undefined;

    return this.postEnvelope(
      {
        kind: 'SUBMISSION_META',
        submission: metaSub,
        task: compactTask,
        bytebinKey,
        fileUrl: bytebinKey ? `${BYTEBIN_BASE}/${bytebinKey}` : undefined,
      },
      true
    );
  }

  public async publishSubmissionUpdate(submission: Submission): Promise<boolean> {
    const metaSub: Submission = {
      ...submission,
      fileData: undefined,
    };
    return this.postEnvelope(
      {
        kind: 'SUBMISSION_UPDATE',
        submission: metaSub,
      },
      true
    );
  }

  public async publishSubmissionDelete(submissionId: string): Promise<boolean> {
    return this.postEnvelope(
      {
        kind: 'SUBMISSION_DELETE',
        submissionId,
      },
      true
    );
  }

  public async publishGame(game: Game): Promise<boolean> {
    return this.postEnvelope({
      kind: 'GAME_UPSERT',
      game,
    });
  }

  public async publishGameDelete(gameId: string): Promise<boolean> {
    return this.postEnvelope({
      kind: 'GAME_DELETE',
      gameId,
    });
  }

  public async publishGameResult(gameResult: GameResult): Promise<boolean> {
    return this.postEnvelope(
      {
        kind: 'GAME_RESULT_ADD',
        gameResult,
      },
      true
    );
  }

  public async publishStudent(student: Student): Promise<boolean> {
    return this.postEnvelope({
      kind: 'STUDENT_UPSERT',
      student,
    });
  }
}

export const cloudSync = new CloudSyncService();
