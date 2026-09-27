import { Classroom, Student, Task, Submission, Game, GameResult, NotificationItem } from '../types';
import {
  DEFAULT_CLASSES,
  DEFAULT_STUDENTS,
  DEFAULT_TASKS,
  DEFAULT_SUBMISSIONS,
  DEFAULT_GAMES,
  DEFAULT_GAME_RESULTS,
  DEFAULT_NOTIFICATIONS,
} from '../data/defaultData';
import { decodeTaskFromUrl } from './taskLink';
import { cloudSync } from './cloudSync';

const STORAGE_KEYS = {
  CLASSES: 'lop_hoc_so_classes',
  STUDENTS: 'lop_hoc_so_students',
  TASKS: 'lop_hoc_so_tasks',
  SUBMISSIONS: 'lop_hoc_so_submissions',
  GAMES: 'lop_hoc_so_games',
  GAME_RESULTS: 'lop_hoc_so_game_results',
  NOTIFICATIONS: 'lop_hoc_so_notifications',
  CLOUD_PUSHED: 'lop_hoc_so_cloud_pushed_v8',
};

type Listener = () => void;

function normStr(s?: string): string {
  return (s || '').trim().toLowerCase();
}

class StorageService {
  private listeners: Set<Listener> = new Set();
  private memoryStore: Map<string, any> = new Map();
  private pollInterval: any = null;
  private isSyncing = false;
  private lastServerVersion = 0;

  private getItem<T>(key: string, defaultVal: T): T {
    if (this.memoryStore.has(key)) {
      return this.memoryStore.get(key) as T;
    }
    try {
      const data = localStorage.getItem(key);
      if (!data) {
        this.memoryStore.set(key, defaultVal);
        return defaultVal;
      }
      const parsed = JSON.parse(data) as T;
      this.memoryStore.set(key, parsed);
      return parsed;
    } catch {
      this.memoryStore.set(key, defaultVal);
      return defaultVal;
    }
  }

  private setItem<T>(key: string, val: T): void {
    this.memoryStore.set(key, val);

    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      if (key === STORAGE_KEYS.SUBMISSIONS && Array.isArray(val)) {
        try {
          const compactSubs = (val as Submission[]).map((s, idx) => {
            if (idx > 3 && s.fileData && s.fileData.length > 50000) {
              return { ...s, fileData: undefined };
            }
            return s;
          });
          localStorage.setItem(key, JSON.stringify(compactSubs));
        } catch {
          // In-memory store retains full data
        }
      }
    }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error('Listener notification error:', err);
      }
    });
  }

  /**
   * Reconciles tasks and submissions across all devices:
   * 1. Deduplicates sample vs user-created tasks with identical titles.
   * 2. Links submissions to existing tasks by ID or normalized taskTitle.
   * 3. Auto-reconstructs any missing Task if a student submitted to a task created on another device/browser.
   * 4. Deduplicates submissions if the same submission was received via multiple channels.
   */
  private reconcileTasksAndSubmissions(): void {
    let tasks = this.getItem<Task[]>(STORAGE_KEYS.TASKS, DEFAULT_TASKS);
    let submissions = this.getItem<Submission[]>(STORAGE_KEYS.SUBMISSIONS, DEFAULT_SUBMISSIONS);
    let tasksChanged = false;
    let subsChanged = false;

    // 1. Deduplicate tasks with identical titles if one is a static seed ID
    const userTaskByTitle = new Map<string, Task>();
    tasks.forEach((t) => {
      if (t.id !== 'task-antoan-11') {
        userTaskByTitle.set(normStr(t.title), t);
      }
    });
    const cleanedTasks = tasks.filter((t) => {
      if (t.id === 'task-antoan-11' && userTaskByTitle.has(normStr(t.title))) {
        tasksChanged = true;
        return false;
      }
      return true;
    });
    tasks = cleanedTasks;

    // 2. Deduplicate submissions by id
    const seenSubIds = new Set<string>();
    const dedupedSubs: Submission[] = [];
    for (const sub of submissions) {
      if (!sub || !sub.id) continue;
      if (seenSubIds.has(sub.id)) {
        subsChanged = true;
        const existingIdx = dedupedSubs.findIndex((s) => s.id === sub.id);
        if (existingIdx >= 0 && sub.fileData && !dedupedSubs[existingIdx].fileData) {
          dedupedSubs[existingIdx] = { ...dedupedSubs[existingIdx], ...sub };
        }
        continue;
      }
      seenSubIds.add(sub.id);
      dedupedSubs.push(sub);
    }
    submissions = dedupedSubs;

    // 3. Ensure every submission is linked to a valid task in `tasks`
    const taskIds = new Set(tasks.map((t) => t.id));
    for (const sub of submissions) {
      if (!taskIds.has(sub.taskId)) {
        const matchedByTitle = sub.taskTitle
          ? tasks.find((t) => normStr(t.title) === normStr(sub.taskTitle))
          : undefined;

        if (matchedByTitle) {
          sub.taskId = matchedByTitle.id;
          subsChanged = true;
        } else if (sub.taskTitle) {
          const inferredGrade = sub.studentClass?.startsWith('12')
            ? 'Khối 12'
            : sub.studentClass?.startsWith('11')
            ? 'Khối 11'
            : 'Khối 10';
          const inferredClasses =
            inferredGrade === 'Khối 12'
              ? ['12A', '12B']
              : inferredGrade === 'Khối 11'
              ? ['11A', '11B']
              : ['10A', '10B'];

          const reconstructedTask: Task = {
            id: sub.taskId || `task-auto-${Date.now()}`,
            title: sub.taskTitle,
            subject: 'Tin học',
            grade: inferredGrade,
            classIds: sub.studentClass
              ? Array.from(new Set([sub.studentClass, ...inferredClasses]))
              : inferredClasses,
            lessonTopic: sub.taskTitle,
            objective: sub.taskTitle,
            requirements: `Hoàn thành và nộp bài tập: ${sub.taskTitle}`,
            instructions: 'Nộp tệp bài làm qua link hoặc mã QR của nhiệm vụ.',
            startDate: '2026-09-01T07:00',
            endDate: '2026-12-31T23:59',
            deadline: '2026-12-31T23:59',
            allowedFileTypes: ['word', 'pdf', 'image', 'powerpoint'],
            teacherNote: '',
            createdAt: sub.submittedAt || new Date().toISOString(),
            status: 'active',
          };
          tasks.unshift(reconstructedTask);
          taskIds.add(reconstructedTask.id);
          tasksChanged = true;
        }
      }
    }

    if (tasksChanged) {
      this.setItem(STORAGE_KEYS.TASKS, tasks);
    }
    if (subsChanged) {
      this.setItem(STORAGE_KEYS.SUBMISSIONS, submissions);
    }
  }

  // --- Initialize Storage ---
  public initialize(): void {
    const SUBJECT_VERSION_KEY = 'lop_hoc_so_subject_version';
    const CURRENT_VERSION = 'tin_hoc_v8_instant_sync';
    const existingVersion = localStorage.getItem(SUBJECT_VERSION_KEY);

    if (existingVersion !== CURRENT_VERSION) {
      const existingTasks = this.getItem<Task[]>(STORAGE_KEYS.TASKS, []);
      const existingSubs = this.getItem<Submission[]>(STORAGE_KEYS.SUBMISSIONS, []);
      const existingStudents = this.getItem<Student[]>(STORAGE_KEYS.STUDENTS, []);
      const existingGames = this.getItem<Game[]>(STORAGE_KEYS.GAMES, []);
      const existingGameResults = this.getItem<GameResult[]>(STORAGE_KEYS.GAME_RESULTS, []);

      const taskMap = new Map<string, Task>();
      existingTasks.forEach((t) => taskMap.set(t.id, t));
      DEFAULT_TASKS.forEach((t) => {
        if (!taskMap.has(t.id)) taskMap.set(t.id, t);
      });

      const subMap = new Map<string, Submission>();
      existingSubs.forEach((s) => subMap.set(s.id, s));
      DEFAULT_SUBMISSIONS.forEach((s) => {
        if (!subMap.has(s.id)) subMap.set(s.id, s);
      });

      const stuMap = new Map<string, Student>();
      DEFAULT_STUDENTS.forEach((s) => stuMap.set(s.id, s));
      existingStudents.forEach((s) => stuMap.set(s.id, s));

      const gameMap = new Map<string, Game>();
      existingGames.forEach((g) => gameMap.set(g.id, g));
      DEFAULT_GAMES.forEach((g) => {
        if (!gameMap.has(g.id)) gameMap.set(g.id, g);
      });

      const grMap = new Map<string, GameResult>();
      existingGameResults.forEach((r) => grMap.set(r.id, r));
      DEFAULT_GAME_RESULTS.forEach((r) => {
        if (!grMap.has(r.id)) grMap.set(r.id, r);
      });

      this.setItem(STORAGE_KEYS.CLASSES, DEFAULT_CLASSES);
      this.setItem(STORAGE_KEYS.STUDENTS, Array.from(stuMap.values()));
      this.setItem(STORAGE_KEYS.TASKS, Array.from(taskMap.values()));
      this.setItem(STORAGE_KEYS.SUBMISSIONS, Array.from(subMap.values()));
      this.setItem(STORAGE_KEYS.GAMES, Array.from(gameMap.values()));
      this.setItem(STORAGE_KEYS.GAME_RESULTS, Array.from(grMap.values()));
      if (!localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS)) {
        this.setItem(STORAGE_KEYS.NOTIFICATIONS, DEFAULT_NOTIFICATIONS);
      }
      try {
        localStorage.setItem(SUBJECT_VERSION_KEY, CURRENT_VERSION);
      } catch {}
    } else {
      if (!localStorage.getItem(STORAGE_KEYS.CLASSES)) {
        this.setItem(STORAGE_KEYS.CLASSES, DEFAULT_CLASSES);
      }
      if (!localStorage.getItem(STORAGE_KEYS.STUDENTS)) {
        this.setItem(STORAGE_KEYS.STUDENTS, DEFAULT_STUDENTS);
      }
      if (!localStorage.getItem(STORAGE_KEYS.TASKS)) {
        this.setItem(STORAGE_KEYS.TASKS, DEFAULT_TASKS);
      }
      if (!localStorage.getItem(STORAGE_KEYS.SUBMISSIONS)) {
        this.setItem(STORAGE_KEYS.SUBMISSIONS, DEFAULT_SUBMISSIONS);
      }
      if (!localStorage.getItem(STORAGE_KEYS.GAMES)) {
        this.setItem(STORAGE_KEYS.GAMES, DEFAULT_GAMES);
      }
      if (!localStorage.getItem(STORAGE_KEYS.GAME_RESULTS)) {
        this.setItem(STORAGE_KEYS.GAME_RESULTS, DEFAULT_GAME_RESULTS);
      }
      if (!localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS)) {
        this.setItem(STORAGE_KEYS.NOTIFICATIONS, DEFAULT_NOTIFICATIONS);
      }
    }

    this.reconcileTasksAndSubmissions();
    this.recalculateAllScores();

    // Adopt task from URL locally ONLY (never broadcast on student page open)
    this.adoptTaskFromCurrentUrl();

    // Listen for cross-tab localStorage changes on the same browser
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (evt) => {
        if (evt.key && Object.values(STORAGE_KEYS).includes(evt.key) && evt.newValue) {
          try {
            this.memoryStore.set(evt.key, JSON.parse(evt.newValue));
            this.reconcileTasksAndSubmissions();
            this.recalculateAllScores();
            this.notifyListeners();
          } catch {
            // ignore
          }
        }
      });
    }

    // Initialize Real-Time Cross-Device Cloud Sync
    this.initCloudSync();

    // Start background syncing with server & cloud
    this.syncFromServer();
    this.startAutoSync();
  }

  private initCloudSync(): void {
    cloudSync.init({
      onTaskUpsert: (incomingTask: Task) => {
        const list = this.getTasks();
        const idx = list.findIndex(
          (t) => t.id === incomingTask.id || normStr(t.title) === normStr(incomingTask.title)
        );
        if (idx >= 0) {
          list[idx] = { ...list[idx], ...incomingTask, id: list[idx].id };
        } else {
          list.unshift(incomingTask);
        }
        this.setItem(STORAGE_KEYS.TASKS, list);
        this.reconcileTasksAndSubmissions();
        this.notifyListeners();
      },
      onTaskDelete: (taskId: string) => {
        const list = this.getTasks().filter((t) => t.id !== taskId);
        this.setItem(STORAGE_KEYS.TASKS, list);
        this.notifyListeners();
      },
      onSubmissionUpsert: (incomingSub: Submission, associatedTask?: Task) => {
        if (associatedTask && associatedTask.id) {
          this.saveTaskLocalOnly(associatedTask);
        }

        const list = this.getSubmissions();
        const idx = list.findIndex((s) => s.id === incomingSub.id);
        const isNew = idx < 0;

        if (idx >= 0) {
          list[idx] = {
            ...list[idx],
            ...incomingSub,
            fileData: incomingSub.fileData || list[idx].fileData,
          };
        } else {
          list.unshift(incomingSub);
        }

        this.setItem(STORAGE_KEYS.SUBMISSIONS, list);
        this.reconcileTasksAndSubmissions();
        this.findOrCreateStudent(incomingSub.studentName, incomingSub.studentClass);
        this.recalculateAllScores();

        if (isNew) {
          this.addNotification({
            id: `notif-cloud-${incomingSub.id}`,
            title: 'Học sinh nộp bài mới (+10đ)',
            message: `${incomingSub.studentName} – Lớp ${incomingSub.studentClass} vừa nộp bài “${incomingSub.taskTitle}” (${incomingSub.fileName}). Đã lưu vào Kho bài nộp & cộng +10 điểm vinh danh!`,
            time: 'Vừa xong',
            type: 'submission',
            unread: true,
            linkTab: 'submissions',
            linkId: incomingSub.id,
          });
        }

        this.notifyListeners();
      },
      onSubmissionDelete: (subId: string) => {
        const list = this.getSubmissions().filter((s) => s.id !== subId);
        this.setItem(STORAGE_KEYS.SUBMISSIONS, list);
        this.recalculateAllScores();
        this.notifyListeners();
      },
      onGameUpsert: (incomingGame: Game) => {
        const list = this.getGames();
        const idx = list.findIndex((g) => g.id === incomingGame.id);
        if (idx >= 0) {
          list[idx] = { ...list[idx], ...incomingGame };
        } else {
          list.unshift(incomingGame);
        }
        this.setItem(STORAGE_KEYS.GAMES, list);
        this.notifyListeners();
      },
      onGameDelete: (gameId: string) => {
        const list = this.getGames().filter((g) => g.id !== gameId);
        this.setItem(STORAGE_KEYS.GAMES, list);
        this.notifyListeners();
      },
      onGameResultAdd: (incomingResult: GameResult) => {
        const list = this.getGameResults();
        if (!list.some((r) => r.id === incomingResult.id)) {
          list.unshift(incomingResult);
          this.setItem(STORAGE_KEYS.GAME_RESULTS, list);
          this.incrementGamePlay(incomingResult.gameId);
          this.findOrCreateStudent(incomingResult.studentName, incomingResult.studentClass);
          this.recalculateAllScores();
          this.notifyListeners();
        }
      },
      onStudentUpsert: (incomingStudent: Student) => {
        const list = this.getStudents();
        const idx = list.findIndex((s) => s.id === incomingStudent.id);
        if (idx >= 0) {
          list[idx] = { ...list[idx], ...incomingStudent };
        } else {
          list.push(incomingStudent);
        }
        this.setItem(STORAGE_KEYS.STUDENTS, list);
        this.recalculateAllScores();
        this.notifyListeners();
      },
    });

    // Only push any unpushed local submissions (never spam tasks on page load)
    this.pushPendingLocalSubmissionsToCloud();
  }

  public async pushPendingLocalSubmissionsToCloud(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const pushedIds = new Set<string>(this.getItem<string[]>(STORAGE_KEYS.CLOUD_PUSHED, []));
      let updated = false;

      const defaultSubIds = new Set(DEFAULT_SUBMISSIONS.map((s) => s.id));
      for (const sub of this.getSubmissions()) {
        if (!defaultSubIds.has(sub.id) && !pushedIds.has(sub.id)) {
          pushedIds.add(sub.id);
          updated = true;
          const assocTask = this.getTaskById(sub.taskId);
          await cloudSync.publishSubmission(sub, assocTask);
        }
      }

      if (updated) {
        this.setItem(STORAGE_KEYS.CLOUD_PUSHED, Array.from(pushedIds));
      }
    } catch {
      // ignore
    }
  }

  /**
   * Saves a task locally (e.g. when a student opens a `?tdata=` link) WITHOUT broadcasting to the cloud.
   * This prevents student browsers from spamming TASK_UPSERT and hitting rate limits.
   */
  public saveTaskLocalOnly(task: Task): Task {
    const list = this.getTasks();
    const index = list.findIndex(
      (t) => t.id === task.id || normStr(t.title) === normStr(task.title)
    );
    if (index >= 0) {
      list[index] = { ...list[index], ...task, id: list[index].id };
    } else {
      list.unshift(task);
    }
    this.setItem(STORAGE_KEYS.TASKS, list);
    this.reconcileTasksAndSubmissions();
    this.notifyListeners();
    return task;
  }

  public adoptTaskFromCurrentUrl(): Task | null {
    if (typeof window === 'undefined') return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const tdata = params.get('tdata');
      if (tdata) {
        const decoded = decodeTaskFromUrl(tdata);
        if (decoded && decoded.id) {
          this.saveTaskLocalOnly(decoded);
          return decoded;
        }
      }
    } catch (e) {
      console.warn('Could not adopt task from URL:', e);
    }
    return null;
  }

  public startAutoSync(): void {
    if (this.pollInterval) return;
    // Gentle 12s background sync since SSE stream already pushes updates in 0.1s
    this.pollInterval = setInterval(() => {
      this.syncFromServer(false);
    }, 12000);
  }

  public stopAutoSync(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Forces an immediate two-way synchronization of all submissions across phones, PCs, Cloud, and Server.
   */
  public async forceSyncAllDevices(): Promise<void> {
    await this.pushPendingLocalSubmissionsToCloud();
    await this.syncFromServer(true);
  }

  // Two-way synchronization: syncs with both Cloud Sync service and /api/data backend
  public async syncFromServer(forceCloudPoll = false): Promise<boolean> {
    if (this.isSyncing && !forceCloudPoll) return false;
    this.isSyncing = true;

    try {
      // 1. Poll cloud sync channel (works on Vercel, mobile 4G/WiFi, and everywhere)
      await cloudSync.pollCloudMessages(forceCloudPoll);

      // 2. Also sync with Express backend if available
      const res = await fetch('/api/data', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Not JSON API');
      }

      const data = await res.json();
      if (!data || !Array.isArray(data.tasks)) {
        throw new Error('Invalid data payload from server');
      }

      const localTasks = this.getTasks();
      const serverTasks: Task[] = Array.isArray(data.tasks) ? data.tasks : [];
      const serverTaskIds = new Set(serverTasks.map((t) => t.id));

      const missingTasksOnServer = localTasks.filter((t) => !serverTaskIds.has(t.id));
      if (missingTasksOnServer.length > 0) {
        missingTasksOnServer.forEach((t) => {
          fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t),
          }).catch(() => {});
        });
      }

      const localSubs = this.getSubmissions();
      const serverSubs: Submission[] = Array.isArray(data.submissions) ? data.submissions : [];
      const serverSubIds = new Set(serverSubs.map((s) => s.id));
      const missingSubsOnServer = localSubs.filter((s) => !serverSubIds.has(s.id));
      if (missingSubsOnServer.length > 0) {
        missingSubsOnServer.forEach((s) => {
          fetch('/api/submissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s),
          }).catch(() => {});
        });
      }

      const taskMap = new Map<string, Task>();
      missingTasksOnServer.forEach((t) => taskMap.set(t.id, t));
      serverTasks.forEach((t) => taskMap.set(t.id, t));
      const mergedTasks = Array.from(taskMap.values());

      const subMap = new Map<string, Submission>();
      missingSubsOnServer.forEach((s) => subMap.set(s.id, s));
      serverSubs.forEach((s) => {
        const existingLocal = localSubs.find((ls) => ls.id === s.id);
        subMap.set(s.id, {
          ...s,
          fileData: s.fileData || existingLocal?.fileData,
        });
      });
      const mergedSubs = Array.from(subMap.values());

      const hasChanged =
        data.version !== this.lastServerVersion ||
        mergedTasks.length !== localTasks.length ||
        mergedSubs.length !== localSubs.length;

      this.lastServerVersion = data.version || Date.now();

      if (hasChanged) {
        if (Array.isArray(data.classes)) this.setItem(STORAGE_KEYS.CLASSES, data.classes);
        if (Array.isArray(data.students)) {
          const stuMap = new Map<string, Student>();
          data.students.forEach((st: Student) => stuMap.set(st.id, st));
          this.getStudents().forEach((st) => {
            if (!stuMap.has(st.id)) stuMap.set(st.id, st);
          });
          this.setItem(STORAGE_KEYS.STUDENTS, Array.from(stuMap.values()));
        }
        this.setItem(STORAGE_KEYS.TASKS, mergedTasks);
        this.setItem(STORAGE_KEYS.SUBMISSIONS, mergedSubs);
        if (Array.isArray(data.games)) this.setItem(STORAGE_KEYS.GAMES, data.games);
        if (Array.isArray(data.gameResults)) this.setItem(STORAGE_KEYS.GAME_RESULTS, data.gameResults);
        if (Array.isArray(data.notifications)) this.setItem(STORAGE_KEYS.NOTIFICATIONS, data.notifications);

        this.reconcileTasksAndSubmissions();
        this.recalculateAllScores();
        this.notifyListeners();
      }

      return true;
    } catch {
      this.reconcileTasksAndSubmissions();
      this.recalculateAllScores();
      this.notifyListeners();
      return true;
    } finally {
      this.isSyncing = false;
    }
  }

  public async fetchTaskById(id: string): Promise<Task | undefined> {
    const existing = this.getTaskById(id);
    if (existing) return existing;

    await cloudSync.pollCloudMessages(true);
    const afterCloud = this.getTaskById(id);
    if (afterCloud) return afterCloud;

    try {
      const res = await fetch(`/api/tasks/${id}`, { cache: 'no-store' });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const task: Task = await res.json();
        if (task && task.id) {
          this.saveTaskLocalOnly(task);
          return task;
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }

  // --- Classes ---
  public getClasses(): Classroom[] {
    return this.getItem(STORAGE_KEYS.CLASSES, DEFAULT_CLASSES);
  }

  public getClassById(id: string): Classroom | undefined {
    return this.getClasses().find((c) => c.id === id);
  }

  public saveClass(classroom: Classroom): Classroom {
    const list = this.getClasses();
    const index = list.findIndex((c) => c.id === classroom.id);
    if (index >= 0) {
      list[index] = classroom;
    } else {
      list.push(classroom);
    }
    this.setItem(STORAGE_KEYS.CLASSES, list);
    this.notifyListeners();

    fetch('/api/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(classroom),
    }).catch(() => {});

    return classroom;
  }

  public deleteClass(classId: string): void {
    const list = this.getClasses().filter((c) => c.id !== classId);
    this.setItem(STORAGE_KEYS.CLASSES, list);
    this.notifyListeners();
  }

  // --- Students ---
  public getStudents(): Student[] {
    return this.getItem(STORAGE_KEYS.STUDENTS, DEFAULT_STUDENTS);
  }

  public getStudentsByClass(classId: string): Student[] {
    const list = this.getStudents();
    if (!classId || classId === 'ALL') return list;
    return list.filter((s) => s.classId === classId);
  }

  public getStudentById(id: string): Student | undefined {
    return this.getStudents().find((s) => s.id === id);
  }

  public getStudentByCodeOrName(classId: string, query: string): Student | undefined {
    const students = this.getStudentsByClass(classId);
    const q = query.toLowerCase().trim();
    return students.find((s) => {
      const matchCode = s.studentCode && s.studentCode.toLowerCase() === q;
      const matchName = s.name.toLowerCase() === q;
      return matchCode || matchName;
    });
  }

  public findOrCreateStudent(name: string, classId: string): Student {
    const normName = name.trim();
    let student = this.getStudents().find(
      (s) => s.classId === classId && s.name.toLowerCase().trim() === normName.toLowerCase()
    );

    if (!student) {
      const clsStudents = this.getStudentsByClass(classId);
      const count = clsStudents.length + 1;
      const code = `HS${classId}${count < 10 ? '0' + count : count}`;
      student = {
        id: `stu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        studentCode: code,
        name: normName,
        classId: classId,
        createdAt: new Date().toISOString(),
        totalScore: 0,
        submissionScore: 0,
        gameScore: 0,
        bonusScore: 0,
        submissionCount: 0,
        gameCount: 0,
        badges: [],
        scoreHistory: [],
      };
      const list = this.getStudents();
      list.push(student);
      this.setItem(STORAGE_KEYS.STUDENTS, list);
      this.updateClassStudentCount(student.classId);
    }
    return student;
  }

  public recalculateAllScores(): void {
    const students = this.getStudents();
    const submissions = this.getSubmissions();
    const gameResults = this.getGameResults();

    students.forEach((student) => {
      const stuSubs = submissions.filter(
        (s) =>
          s.studentClass === student.classId &&
          s.studentName.toLowerCase().trim() === student.name.toLowerCase().trim()
      );
      const stuGames = gameResults.filter(
        (g) =>
          g.studentClass === student.classId &&
          g.studentName.toLowerCase().trim() === student.name.toLowerCase().trim()
      );

      let subScore = 0;
      const history: any[] = [];

      stuSubs.forEach((sub) => {
        subScore += 10;
        history.push({
          id: `hist-sub-${sub.id}`,
          type: 'submission',
          title: `Nộp bài: ${sub.taskTitle}`,
          pointsEarned: 10,
          date: sub.submittedAt,
          referenceId: sub.taskId,
        });

        if (sub.score !== undefined && sub.score !== null) {
          const gradePoints = Math.round(Number(sub.score) * 10);
          subScore += gradePoints;
          history.push({
            id: `hist-grade-${sub.id}`,
            type: 'review',
            title: `Cô Dung chấm điểm: ${sub.taskTitle} (${sub.score}/10đ)`,
            pointsEarned: gradePoints,
            date: sub.submittedAt,
            note: sub.teacherFeedback || 'Đã chấm điểm hoàn thành nhiệm vụ',
            referenceId: sub.id,
          });
        }
      });

      let gameScore = 0;
      stuGames.forEach((res) => {
        gameScore += res.score;
        history.push({
          id: `hist-game-${res.id}`,
          type: 'game',
          title: `Trò chơi củng cố: ${res.gameTitle} (${res.correctCount}/${res.totalQuestions} đúng)`,
          pointsEarned: res.score,
          date: res.completedAt,
          referenceId: res.gameId,
        });
      });

      const bonus = student.bonusScore || 0;
      if (student.scoreHistory) {
        student.scoreHistory
          .filter((h) => h.type === 'bonus')
          .forEach((b) => {
            if (!history.find((x) => x.id === b.id)) {
              history.push(b);
            }
          });
      }

      const total = subScore + gameScore + bonus;

      const badges: any[] = [];
      if (stuSubs.length >= 1) {
        badges.push({
          id: 'badge-first-sub',
          name: 'Tiên Phong Nộp Bài',
          icon: 'target',
          description: 'Đã hoàn thành và nộp bài tập đúng hạn',
          earnedAt: stuSubs[0].submittedAt,
        });
      }
      if (stuSubs.length >= 2) {
        badges.push({
          id: 'badge-hardworking',
          name: 'Chiến Binh Chăm Chỉ',
          icon: 'flame',
          description: 'Nộp từ 2 bài tập trở lên',
          earnedAt: stuSubs[stuSubs.length - 1].submittedAt,
        });
      }
      if (stuGames.length >= 1) {
        badges.push({
          id: 'badge-first-game',
          name: 'Khám Phá Trò Chơi',
          icon: 'zap',
          description: 'Đã tham gia thử thách trò chơi Tin học',
          earnedAt: stuGames[0].completedAt,
        });
      }
      if (stuGames.some((g) => g.score >= 100)) {
        badges.push({
          id: 'badge-perfect-score',
          name: 'Thủ Khoa Trắc Nghiệm',
          icon: 'trophy',
          description: 'Đạt điểm tuyệt đối 100/100 trong trò chơi củng cố',
          earnedAt: new Date().toISOString(),
        });
      }
      if (total >= 150) {
        badges.push({
          id: 'badge-tech-star',
          name: 'Ngôi Sao Tin Học',
          icon: 'star',
          description: 'Đạt tổng điểm tích lũy trên 150 điểm môn Tin học',
          earnedAt: new Date().toISOString(),
        });
      }

      history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      student.submissionScore = subScore;
      student.gameScore = gameScore;
      student.bonusScore = bonus;
      student.totalScore = total;
      student.submissionCount = stuSubs.length;
      student.gameCount = stuGames.length;
      student.badges = badges;
      student.scoreHistory = history;
    });

    const classIds = Array.from(new Set(students.map((s) => s.classId)));
    classIds.forEach((cid) => {
      const inClass = students.filter((s) => s.classId === cid);
      inClass.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
      inClass.forEach((st, idx) => {
        st.rankInClass = idx + 1;
      });
    });

    this.setItem(STORAGE_KEYS.STUDENTS, students);
  }

  public addBonusScore(studentId: string, points: number, reason: string): void {
    const students = this.getStudents();
    const student = students.find((s) => s.id === studentId);
    if (student) {
      student.bonusScore = (student.bonusScore || 0) + points;
      const historyItem = {
        id: `hist-bonus-${Date.now()}`,
        type: 'bonus' as const,
        title: reason || 'Cô Dung thưởng điểm phát biểu / rèn luyện',
        pointsEarned: points,
        date: new Date().toISOString(),
        note: 'Điểm thưởng trực tiếp từ giáo viên',
      };
      student.scoreHistory = [historyItem, ...(student.scoreHistory || [])];
      this.setItem(STORAGE_KEYS.STUDENTS, students);
      this.recalculateAllScores();
      this.notifyListeners();

      cloudSync.publishStudent(student).catch(() => {});

      fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(student),
      }).catch(() => {});
    }
  }

  public saveStudent(student: Student): Student {
    const list = this.getStudents();
    const index = list.findIndex((s) => s.id === student.id);
    if (index >= 0) {
      list[index] = student;
    } else {
      list.push(student);
    }
    this.setItem(STORAGE_KEYS.STUDENTS, list);
    this.updateClassStudentCount(student.classId);
    this.recalculateAllScores();
    this.notifyListeners();

    cloudSync.publishStudent(student).catch(() => {});

    fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(student),
    }).catch(() => {});

    return student;
  }

  public saveStudents(newStudents: Student[]): void {
    const list = this.getStudents();
    newStudents.forEach((stu) => {
      const idx = list.findIndex(
        (s) =>
          s.id === stu.id ||
          (s.studentCode &&
            stu.studentCode &&
            s.studentCode === stu.studentCode &&
            s.classId === stu.classId)
      );
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...stu };
      } else {
        list.push(stu);
      }
    });
    this.setItem(STORAGE_KEYS.STUDENTS, list);

    const affectedClasses = Array.from(new Set(newStudents.map((s) => s.classId)));
    affectedClasses.forEach((cid) => this.updateClassStudentCount(cid));
    this.recalculateAllScores();
    this.notifyListeners();

    newStudents.forEach((st) => {
      cloudSync.publishStudent(st).catch(() => {});
      fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(st),
      }).catch(() => {});
    });
  }

  public deleteStudent(studentId: string): void {
    const list = this.getStudents();
    const student = list.find((s) => s.id === studentId);
    const filtered = list.filter((s) => s.id !== studentId);
    this.setItem(STORAGE_KEYS.STUDENTS, filtered);
    if (student) {
      this.updateClassStudentCount(student.classId);
    }
    this.notifyListeners();

    fetch(`/api/students/${studentId}`, { method: 'DELETE' }).catch(() => {});
  }

  public deleteStudents(studentIds: string[]): void {
    const list = this.getStudents();
    const idSet = new Set(studentIds);
    const affectedClasses = new Set(list.filter((s) => idSet.has(s.id)).map((s) => s.classId));
    const filtered = list.filter((s) => !idSet.has(s.id));
    this.setItem(STORAGE_KEYS.STUDENTS, filtered);
    affectedClasses.forEach((cid) => this.updateClassStudentCount(cid));
    this.notifyListeners();

    studentIds.forEach((id) => {
      fetch(`/api/students/${id}`, { method: 'DELETE' }).catch(() => {});
    });
  }

  private updateClassStudentCount(classId: string): void {
    const classes = this.getClasses();
    const cls = classes.find((c) => c.id === classId);
    if (cls) {
      const count = this.getStudentsByClass(classId).length;
      cls.studentCount = count;
      this.setItem(STORAGE_KEYS.CLASSES, classes);
    }
  }

  // --- Tasks ---
  public getTasks(): Task[] {
    const list = this.getItem(STORAGE_KEYS.TASKS, DEFAULT_TASKS);
    return list.map((t) => ({
      ...t,
      startDate: t.startDate || t.createdAt?.slice(0, 16) || '2026-09-01T08:00',
      endDate: t.endDate || t.deadline || '2026-10-30T23:59',
      deadline: t.endDate || t.deadline || '2026-10-30T23:59',
    }));
  }

  public getTaskById(id: string): Task | undefined {
    return this.getTasks().find((t) => t.id === id);
  }

  public saveTask(task: Task): Task {
    this.saveTaskLocalOnly(task);

    const pushedIds = new Set<string>(this.getItem<string[]>(STORAGE_KEYS.CLOUD_PUSHED, []));
    pushedIds.add(task.id);
    this.setItem(STORAGE_KEYS.CLOUD_PUSHED, Array.from(pushedIds));
    cloudSync.publishTask(task).catch(() => {});

    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    }).catch(() => {});

    return task;
  }

  public deleteTask(taskId: string): void {
    const list = this.getTasks().filter((t) => t.id !== taskId);
    this.setItem(STORAGE_KEYS.TASKS, list);
    this.notifyListeners();

    cloudSync.publishTaskDelete(taskId).catch(() => {});
    fetch(`/api/tasks/${taskId}`, { method: 'DELETE' }).catch(() => {});
  }

  // --- Submissions ---
  public getSubmissions(): Submission[] {
    return this.getItem(STORAGE_KEYS.SUBMISSIONS, DEFAULT_SUBMISSIONS);
  }

  public getSubmissionsByTaskId(taskId: string): Submission[] {
    const task = this.getTaskById(taskId);
    const normTitle = task ? normStr(task.title) : '';
    return this.getSubmissions().filter(
      (s) => s.taskId === taskId || (normTitle && normStr(s.taskTitle) === normTitle)
    );
  }

  public getSubmissionsByClass(classId: string): Submission[] {
    return this.getSubmissions().filter(
      (s) => s.studentClass === classId || s.studentClass.includes(classId)
    );
  }

  public async addSubmissionAsync(submission: Submission, associatedTask?: Task): Promise<Submission> {
    const taskObj = associatedTask || this.getTaskById(submission.taskId);
    if (taskObj) {
      // Save locally ONLY; task metadata is bundled inside publishSubmission
      this.saveTaskLocalOnly(taskObj);
    }
    this.addSubmissionLocal(submission);

    const pushedIds = new Set<string>(this.getItem<string[]>(STORAGE_KEYS.CLOUD_PUSHED, []));
    pushedIds.add(submission.id);
    this.setItem(STORAGE_KEYS.CLOUD_PUSHED, Array.from(pushedIds));

    // Push to both Cloud Sync (Bytebin + Ntfy + BroadcastChannel) and Express backend concurrently
    const cloudPromise = cloudSync.publishSubmission(submission, taskObj).catch(() => false);
    const serverPromise = fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...submission, _task: taskObj }),
    }).catch(() => null);

    await Promise.race([
      Promise.all([cloudPromise, serverPromise]),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    return submission;
  }

  private addSubmissionLocal(submission: Submission): Submission {
    const list = this.getSubmissions();
    const existingIdx = list.findIndex((s) => s.id === submission.id);
    if (existingIdx >= 0) {
      list[existingIdx] = submission;
    } else {
      list.unshift(submission);
    }
    this.setItem(STORAGE_KEYS.SUBMISSIONS, list);
    this.reconcileTasksAndSubmissions();

    this.findOrCreateStudent(submission.studentName, submission.studentClass);
    this.recalculateAllScores();

    this.addNotification({
      id: `notif-${submission.id}`,
      title: 'Học sinh nộp bài mới (+10đ)',
      message: `${submission.studentName} – Lớp ${submission.studentClass} vừa nộp bài “${submission.taskTitle}” (${submission.fileName}). Đã lưu vào Kho bài nộp & cộng +10 điểm vinh danh!`,
      time: 'Vừa xong',
      type: 'submission',
      unread: true,
      linkTab: 'submissions',
      linkId: submission.id,
    });

    this.notifyListeners();
    return submission;
  }

  public addSubmission(submission: Submission): Submission {
    this.addSubmissionAsync(submission).catch(() => {});
    return submission;
  }

  public saveSubmission(submission: Submission): Submission {
    return this.addSubmission(submission);
  }

  public updateSubmission(submission: Submission): void {
    const list = this.getSubmissions();
    const index = list.findIndex((s) => s.id === submission.id);
    if (index >= 0) {
      list[index] = submission;
      this.setItem(STORAGE_KEYS.SUBMISSIONS, list);
      this.recalculateAllScores();
      this.notifyListeners();

      cloudSync.publishSubmissionUpdate(submission).catch(() => {});

      fetch(`/api/submissions/${submission.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      }).catch(() => {});
    }
  }

  public deleteSubmission(subId: string): void {
    const list = this.getSubmissions().filter((s) => s.id !== subId);
    this.setItem(STORAGE_KEYS.SUBMISSIONS, list);
    this.recalculateAllScores();
    this.notifyListeners();

    cloudSync.publishSubmissionDelete(subId).catch(() => {});
    fetch(`/api/submissions/${subId}`, { method: 'DELETE' }).catch(() => {});
  }

  // --- Games ---
  public getGames(): Game[] {
    return this.getItem(STORAGE_KEYS.GAMES, DEFAULT_GAMES);
  }

  public getGameById(id: string): Game | undefined {
    return this.getGames().find((g) => g.id === id);
  }

  public saveGame(game: Game): Game {
    const list = this.getGames();
    const index = list.findIndex((g) => g.id === game.id);
    if (index >= 0) {
      list[index] = game;
    } else {
      list.unshift(game);
    }
    this.setItem(STORAGE_KEYS.GAMES, list);
    this.notifyListeners();

    cloudSync.publishGame(game).catch(() => {});

    fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(game),
    }).catch(() => {});

    return game;
  }

  public deleteGame(gameId: string): void {
    const list = this.getGames().filter((g) => g.id !== gameId);
    this.setItem(STORAGE_KEYS.GAMES, list);
    this.notifyListeners();

    cloudSync.publishGameDelete(gameId).catch(() => {});
    fetch(`/api/games/${gameId}`, { method: 'DELETE' }).catch(() => {});
  }

  public incrementGamePlay(gameId: string): void {
    const list = this.getGames();
    const game = list.find((g) => g.id === gameId);
    if (game) {
      game.playCount = (game.playCount || 0) + 1;
      this.setItem(STORAGE_KEYS.GAMES, list);
    }
  }

  // --- Game Results & Rankings ---
  public getGameResults(): GameResult[] {
    return this.getItem(STORAGE_KEYS.GAME_RESULTS, DEFAULT_GAME_RESULTS);
  }

  public getResultsByGameId(gameId: string): GameResult[] {
    return this.getGameResults()
      .filter((r) => r.gameId === gameId)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeSpentSeconds - b.timeSpentSeconds;
      });
  }

  public addGameResult(result: GameResult): GameResult {
    const list = this.getGameResults();
    list.unshift(result);
    this.setItem(STORAGE_KEYS.GAME_RESULTS, list);
    this.incrementGamePlay(result.gameId);

    this.findOrCreateStudent(result.studentName, result.studentClass);
    this.recalculateAllScores();

    this.addNotification({
      id: `notif-${Date.now()}`,
      title: 'Hoàn thành trò chơi củng cố',
      message: `${result.studentName} – ${result.studentClass} vừa đạt ${result.score}/${result.maxScore} điểm trò chơi “${result.gameTitle}” (+${result.score} điểm vào tài khoản).`,
      time: 'Vừa xong',
      type: 'game',
      unread: true,
      linkTab: 'results',
      linkId: result.gameId,
    });

    this.notifyListeners();

    cloudSync.publishGameResult(result).catch(() => {});

    fetch('/api/game-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    }).catch(() => {});

    return result;
  }

  public saveGameResult(result: GameResult): GameResult {
    return this.addGameResult(result);
  }

  // --- Notifications ---
  public getNotifications(): NotificationItem[] {
    return this.getItem(STORAGE_KEYS.NOTIFICATIONS, DEFAULT_NOTIFICATIONS);
  }

  public addNotification(item: NotificationItem): void {
    const list = this.getNotifications();
    if (list.some((n) => n.id === item.id)) return;
    list.unshift(item);
    if (list.length > 50) list.pop();
    this.setItem(STORAGE_KEYS.NOTIFICATIONS, list);
  }

  public markNotificationRead(id: string): void {
    const list = this.getNotifications().map((n) =>
      n.id === id ? { ...n, unread: false, read: true } : n
    );
    this.setItem(STORAGE_KEYS.NOTIFICATIONS, list);
    this.notifyListeners();

    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }

  public markAllNotificationsRead(): void {
    const list = this.getNotifications().map((n) => ({ ...n, unread: false, read: true }));
    this.setItem(STORAGE_KEYS.NOTIFICATIONS, list);
    this.notifyListeners();

    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  }

  // --- Export & Reset ---
  public exportData(): string {
    const fullData = {
      classes: this.getClasses(),
      students: this.getStudents(),
      tasks: this.getTasks(),
      submissions: this.getSubmissions(),
      games: this.getGames(),
      gameResults: this.getGameResults(),
      notifications: this.getNotifications(),
      exportedAt: new Date().toISOString(),
      teacherName: 'Cô giáo Nguyễn Thị Dung',
      schoolSystem: 'Lớp Học Số THPT',
    };
    return JSON.stringify(fullData, null, 2);
  }

  public importData(jsonString: string): boolean {
    try {
      const data = JSON.parse(jsonString);
      if (data.classes) this.setItem(STORAGE_KEYS.CLASSES, data.classes);
      if (data.students) this.setItem(STORAGE_KEYS.STUDENTS, data.students);
      if (data.tasks) this.setItem(STORAGE_KEYS.TASKS, data.tasks);
      if (data.submissions) this.setItem(STORAGE_KEYS.SUBMISSIONS, data.submissions);
      if (data.games) this.setItem(STORAGE_KEYS.GAMES, data.games);
      if (data.gameResults) this.setItem(STORAGE_KEYS.GAME_RESULTS, data.gameResults);
      if (data.notifications) this.setItem(STORAGE_KEYS.NOTIFICATIONS, data.notifications);
      this.reconcileTasksAndSubmissions();
      this.recalculateAllScores();
      this.notifyListeners();
      return true;
    } catch (e) {
      console.error('Import failed', e);
      return false;
    }
  }

  public resetToSampleData(): void {
    this.setItem(STORAGE_KEYS.CLASSES, DEFAULT_CLASSES);
    this.setItem(STORAGE_KEYS.STUDENTS, DEFAULT_STUDENTS);
    this.setItem(STORAGE_KEYS.TASKS, DEFAULT_TASKS);
    this.setItem(STORAGE_KEYS.SUBMISSIONS, DEFAULT_SUBMISSIONS);
    this.setItem(STORAGE_KEYS.GAMES, DEFAULT_GAMES);
    this.setItem(STORAGE_KEYS.GAME_RESULTS, DEFAULT_GAME_RESULTS);
    this.setItem(STORAGE_KEYS.NOTIFICATIONS, DEFAULT_NOTIFICATIONS);
    this.recalculateAllScores();
    this.notifyListeners();

    fetch('/api/reset', { method: 'POST' }).catch(() => {});
  }
}

export const storage = new StorageService();
storage.initialize();
