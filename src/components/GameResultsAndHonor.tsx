import React, { useState, useEffect } from 'react';
import { Classroom, Game, GameResult, Student, Submission } from '../types';
import {
  Trophy,
  Award,
  Sparkles,
  Clock,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Download,
  Gamepad2,
  FileText,
  RefreshCw,
  Star,
  Eye,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { storage } from '../services/storage';

interface GameResultsAndHonorProps {
  games: Game[];
  classes: Classroom[];
  gameResults: GameResult[];
  students?: Student[];
  submissions?: Submission[];
  initialGameId?: string;
  onOpenSubmissionPreview?: (sub: Submission) => void;
}

export const GameResultsAndHonor: React.FC<GameResultsAndHonorProps> = ({
  games,
  classes,
  gameResults,
  students = [],
  submissions = [],
  initialGameId,
  onOpenSubmissionPreview,
}) => {
  const [honorMode, setHonorMode] = useState<'overall' | 'games'>(
    initialGameId ? 'games' : 'overall'
  );
  const [selectedGameId, setSelectedGameId] = useState<string>(
    initialGameId || games[0]?.id || 'ALL'
  );
  const [selectedClass, setSelectedClass] = useState<string>('ALL');
  const [search, setSearch] = useState<string>('');
  const [isProjectorMode, setIsProjectorMode] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const triggerConfetti = () => {
    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6'],
    });
  };

  useEffect(() => {
    if (initialGameId) {
      setSelectedGameId(initialGameId);
      setHonorMode('games');
    }
  }, [initialGameId]);

  const handleManualSync = async () => {
    setIsSyncing(true);
    await storage.forceSyncAllDevices();
    setTimeout(() => setIsSyncing(false), 600);
  };

  // --- Overall Student Honor Roll (Homework Submissions + Games + Bonus) ---
  const allStudents = students.length > 0 ? students : storage.getStudents();
  const allSubmissions = submissions.length > 0 ? submissions : storage.getSubmissions();

  const filteredOverallStudents = allStudents
    .filter((s) => {
      if (selectedClass !== 'ALL' && s.classId !== selectedClass) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.classId.toLowerCase().includes(q) ||
          (s.studentCode || '').toLowerCase().includes(q)
        );
      }
      return (s.totalScore || 0) > 0 || (s.submissionCount || 0) > 0;
    })
    .sort((a, b) => {
      if ((b.totalScore || 0) !== (a.totalScore || 0)) {
        return (b.totalScore || 0) - (a.totalScore || 0);
      }
      return (b.submissionCount || 0) - (a.submissionCount || 0);
    });

  const top5Overall = filteredOverallStudents.slice(0, 5);

  // --- Game Results Ranking ---
  const filteredResults = gameResults
    .filter((r) => {
      if (selectedGameId !== 'ALL' && r.gameId !== selectedGameId) return false;
      if (selectedClass !== 'ALL' && !r.studentClass.includes(selectedClass)) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return r.studentName.toLowerCase().includes(q) || r.studentClass.toLowerCase().includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.timeSpentSeconds - b.timeSpentSeconds;
    });

  const top5Games = filteredResults.slice(0, 5);
  const avgGameScore =
    filteredResults.length > 0
      ? Math.round(
          (filteredResults.reduce((acc, r) => acc + r.score, 0) / filteredResults.length) * 10
        ) / 10
      : 0;

  const handleExportCSV = () => {
    if (honorMode === 'overall') {
      const headers = [
        'Xếp hạng',
        'Mã HS',
        'Họ và tên',
        'Lớp',
        'Tổng điểm vinh danh',
        'Điểm nộp bài tập',
        'Số bài đã nộp',
        'Điểm trò chơi',
        'Điểm thưởng',
        'Huy hiệu đạt được',
      ];
      const rows = filteredOverallStudents.map((s, idx) => [
        idx + 1,
        `"${s.studentCode || ''}"`,
        `"${s.name}"`,
        `"${s.classId}"`,
        s.totalScore || 0,
        s.submissionScore || 0,
        s.submissionCount || 0,
        s.gameScore || 0,
        s.bonusScore || 0,
        `"${(s.badges || []).map((b) => b.name).join(', ')}"`,
      ]);
      const csvContent =
        '\uFEFF' + [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Bang_Vinh_Danh_Tong_Hop_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }

    const headers = [
      'Xếp hạng',
      'Họ và tên',
      'Lớp',
      'Trò chơi',
      'Điểm số',
      'Số câu đúng',
      'Tổng số câu',
      'Thời gian hoàn thành (giây)',
      'Thời điểm tham gia',
    ];
    const rows = filteredResults.map((r, idx) => [
      idx + 1,
      `"${r.studentName}"`,
      `"${r.studentClass}"`,
      `"${r.gameTitle.replace(/"/g, '""')}"`,
      r.score,
      r.correctCount,
      r.totalQuestions,
      r.timeSpentSeconds,
      `"${new Date(r.completedAt).toLocaleString('vi-VN')}"`,
    ]);

    const csvContent =
      '\uFEFF' + [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Ket_Qua_Xep_Hang_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={`space-y-6 pb-12 ${
        isProjectorMode ? 'fixed inset-0 z-50 bg-slate-950 p-6 overflow-y-auto text-white' : ''
      }`}
    >
      {/* Top Banner */}
      <div
        className={`rounded-2xl border p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4 ${
          isProjectorMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 uppercase">
            <Trophy className="w-4 h-4" />
            <span>Xếp Hạng & Vinh Danh Học Sinh Tích Cực</span>
          </div>
          <h2
            className={`text-xl sm:text-2xl font-bold font-display mt-1 ${
              isProjectorMode ? 'text-white' : 'text-slate-900'
            }`}
          >
            🏆 BẢNG VINH DANH CHUYÊN CẦN NỘP BÀI & TRÒ CHƠI
          </h2>
          <p
            className={`text-xs mt-0.5 ${
              isProjectorMode ? 'text-slate-400' : 'text-slate-500'
            }`}
          >
            Tự động cộng +10 điểm chuyên cần ngay khi học sinh nộp bài tập, cộng điểm chấm bài của cô Dung và điểm trò chơi củng cố.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleManualSync}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-xs font-bold rounded-xl transition-all cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Đang đồng bộ...' : 'Đồng bộ điểm & bài nộp'}</span>
          </button>

          <button
            onClick={triggerConfetti}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white text-xs font-bold rounded-xl shadow-md transition-all cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            <span>Chúc mừng TOP 5 🎉</span>
          </button>

          <button
            onClick={() => setIsProjectorMode(!isProjectorMode)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 border rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
              isProjectorMode
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {isProjectorMode ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
            <span>{isProjectorMode ? 'Thu nhỏ' : 'Chiếu bảng'}</span>
          </button>

          {!isProjectorMode && (
            <button
              onClick={handleExportCSV}
              className="p-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs cursor-pointer"
              title="Xuất bảng vinh danh CSV"
            >
              <Download className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Mode Switcher + Class Filter */}
      <div
        className={`p-4 rounded-2xl border shadow-xs space-y-3 ${
          isProjectorMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Honor Mode Tabs */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setHonorMode('overall')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                honorMode === 'overall'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : isProjectorMode
                  ? 'bg-slate-800 text-slate-300'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Award className="w-4 h-4" />
              <span>Vinh Danh Tổng Hợp (Nộp Bài Tập + Trò Chơi)</span>
            </button>

            <button
              onClick={() => setHonorMode('games')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                honorMode === 'games'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : isProjectorMode
                  ? 'bg-slate-800 text-slate-300'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Gamepad2 className="w-4 h-4" />
              <span>Xếp Hạng Theo Từng Trò Chơi</span>
            </button>
          </div>

          {/* Class Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 font-medium">Lớp:</span>
            <button
              onClick={() => setSelectedClass('ALL')}
              className={`px-2.5 py-1 rounded-lg font-medium cursor-pointer ${
                selectedClass === 'ALL'
                  ? 'bg-slate-900 text-white font-bold'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              Tất cả
            </button>
            {classes.map((cls) => (
              <button
                key={cls.id}
                onClick={() => setSelectedClass(cls.id)}
                className={`px-2.5 py-1 rounded-lg font-medium cursor-pointer ${
                  selectedClass === cls.id
                    ? 'bg-emerald-600 text-white font-bold'
                    : 'bg-slate-100 text-slate-700'
                }`}
              >
                {cls.id}
              </button>
            ))}
          </div>
        </div>

        {honorMode === 'games' && (
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-2 border-t border-slate-100">
            <span className="text-xs text-slate-400 font-medium">Chọn trò chơi:</span>
            {games.map((g) => (
              <button
                key={g.id}
                onClick={() => setSelectedGameId(g.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                  selectedGameId === g.id
                    ? 'bg-amber-600 text-white shadow-xs'
                    : isProjectorMode
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {g.title.length > 35 ? g.title.slice(0, 35) + '...' : g.title}
              </button>
            ))}
            <button
              onClick={() => setSelectedGameId('ALL')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                selectedGameId === 'ALL'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : isProjectorMode
                  ? 'bg-slate-800 text-slate-300'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              Tất cả các trò chơi
            </button>
          </div>
        )}
      </div>

      {honorMode === 'overall' ? (
        <>
          {/* OVERALL PODIUM (HOMEWORK SUBMISSIONS + GAMES + BONUS) */}
          <section
            className={`p-6 sm:p-8 rounded-3xl border shadow-lg relative overflow-hidden ${
              isProjectorMode
                ? 'bg-gradient-to-b from-slate-900 to-emerald-950 border-emerald-500/30'
                : 'bg-gradient-to-br from-emerald-500/10 via-amber-50/40 to-teal-50/30 border-emerald-300/80'
            }`}
          >
            <div className="text-center max-w-xl mx-auto mb-6">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-800 font-extrabold text-xs tracking-wider uppercase mb-2">
                <Sparkles className="w-4 h-4 text-emerald-600" />
                <span>VINH DANH HỌC SINH CHĂM CHỈ & XUẤT SẮC</span>
              </div>
              <h3
                className={`text-2xl sm:text-3xl font-display font-extrabold ${
                  isProjectorMode ? 'text-white' : 'text-slate-900'
                }`}
              >
                🏆 TOP 5 HỌC SINH ĐIỂM TÍCH LŨY CAO NHẤT
              </h3>
              <p
                className={`text-xs mt-1 ${
                  isProjectorMode ? 'text-slate-300' : 'text-slate-600'
                }`}
              >
                Tổng hợp từ điểm chuyên cần nộp bài tập (+10đ/bài), điểm chấm bài của giáo viên và điểm trò chơi.
              </p>
            </div>

            {top5Overall.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">
                Chưa có dữ liệu điểm tích lũy cho lớp này.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-3.5 items-stretch">
                {top5Overall.map((stu, idx) => {
                  const rankLabels = ['🥇 TOP 1', '🥈 TOP 2', '🥉 TOP 3', '⭐ TOP 4', '⭐ TOP 5'];
                  const styles = [
                    {
                      card: 'border-2 border-amber-400 bg-gradient-to-b from-amber-50 to-white ring-4 ring-amber-400/20 shadow-lg sm:-translate-y-2',
                      badge: 'bg-amber-500 text-white font-extrabold',
                    },
                    {
                      card: 'border-2 border-slate-300 bg-gradient-to-b from-slate-50 to-white shadow-md',
                      badge: 'bg-slate-600 text-white font-extrabold',
                    },
                    {
                      card: 'border-2 border-amber-700/40 bg-gradient-to-b from-amber-50/50 to-white shadow-md',
                      badge: 'bg-amber-800 text-white font-extrabold',
                    },
                    {
                      card: 'border border-slate-200 bg-white/90 shadow-xs',
                      badge: 'bg-slate-200 text-slate-800 font-bold',
                    },
                    {
                      card: 'border border-slate-200 bg-white/90 shadow-xs',
                      badge: 'bg-slate-200 text-slate-800 font-bold',
                    },
                  ][idx];

                  return (
                    <div
                      key={stu.id}
                      className={`p-4 rounded-2xl flex flex-col justify-between text-center transition-all duration-200 ${
                        styles.card
                      } ${isProjectorMode ? 'bg-slate-800/90 text-white' : ''}`}
                    >
                      <div>
                        <div className="flex justify-center mb-2">
                          <span
                            className={`px-3 py-1 rounded-xl text-xs font-display tracking-tight shadow-xs ${styles.badge}`}
                          >
                            {rankLabels[idx]}
                          </span>
                        </div>

                        <div
                          className={`font-display font-extrabold text-base tracking-tight truncate ${
                            isProjectorMode ? 'text-white' : 'text-slate-900'
                          }`}
                          title={stu.name}
                        >
                          {stu.name}
                        </div>

                        <div
                          className={`text-xs font-bold mt-0.5 ${
                            isProjectorMode ? 'text-emerald-300' : 'text-emerald-700'
                          }`}
                        >
                          Lớp {stu.classId} · {stu.studentCode}
                        </div>
                      </div>

                      <div
                        className={`mt-3 pt-3 border-t ${
                          isProjectorMode ? 'border-slate-700' : 'border-slate-100'
                        }`}
                      >
                        <div className="text-xl font-black font-display text-emerald-800 tabular-nums">
                          {stu.totalScore || 0}đ
                        </div>
                        <div
                          className={`text-[11px] mt-1 flex items-center justify-center gap-2 ${
                            isProjectorMode ? 'text-slate-300' : 'text-slate-600'
                          }`}
                        >
                          <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                            <FileText className="w-3 h-3" />
                            {stu.submissionCount || 0} bài nộp ({stu.submissionScore || 0}đ)
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* OVERALL RANKING TABLE WITH HOMEWORK SUBMISSIONS */}
          <section
            className={`rounded-2xl border shadow-xs overflow-hidden ${
              isProjectorMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <div
              className={`p-4 border-b flex flex-wrap items-center justify-between gap-2 text-xs ${
                isProjectorMode
                  ? 'border-slate-800 text-slate-300'
                  : 'border-slate-100 text-slate-700 bg-slate-50'
              }`}
            >
              <div className="font-bold font-display uppercase tracking-wide">
                Bảng Vinh Danh & Điểm Tích Lũy Học Sinh ({filteredOverallStudents.length} học sinh)
              </div>
              <div className="text-[11px] text-emerald-700 font-semibold">
                Nộp bài tập: +10đ chuyên cần/bài · Chấm điểm: +Điểm×10 · Trò chơi: +Điểm đạt được
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead
                  className={`border-b font-semibold ${
                    isProjectorMode
                      ? 'bg-slate-800/60 border-slate-700 text-slate-400'
                      : 'bg-slate-50 border-slate-200 text-slate-600'
                  }`}
                >
                  <tr>
                    <th className="py-3 px-4 w-16 text-center">Hạng</th>
                    <th className="py-3 px-4">Học sinh</th>
                    <th className="py-3 px-3">Lớp</th>
                    <th className="py-3 px-4 text-center">Bài tập đã nộp</th>
                    <th className="py-3 px-4 text-center">Điểm bài tập</th>
                    <th className="py-3 px-4 text-center">Điểm trò chơi</th>
                    <th className="py-3 px-4 text-center">Tổng điểm vinh danh</th>
                    <th className="py-3 px-4">Huy hiệu & Bài nộp mới nhất</th>
                  </tr>
                </thead>
                <tbody
                  className={`divide-y ${
                    isProjectorMode ? 'divide-slate-800' : 'divide-slate-100'
                  }`}
                >
                  {filteredOverallStudents.map((stu, index) => {
                    const isTop1 = index === 0;
                    const isTop5 = index < 5;
                    const stuSubs = allSubmissions.filter(
                      (s) =>
                        s.studentClass === stu.classId &&
                        s.studentName.toLowerCase().trim() === stu.name.toLowerCase().trim()
                    );
                    const latestSub = stuSubs[0];

                    return (
                      <tr
                        key={stu.id}
                        className={`transition-colors ${
                          isTop1
                            ? isProjectorMode
                              ? 'bg-amber-950/20'
                              : 'bg-amber-50/40'
                            : isProjectorMode
                            ? 'hover:bg-slate-800/50'
                            : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3 px-4 text-center font-bold">
                          {index === 0 && <span className="text-amber-500 font-display">🥇 1</span>}
                          {index === 1 && <span className="text-slate-400 font-display">🥈 2</span>}
                          {index === 2 && <span className="text-amber-700 font-display">🥉 3</span>}
                          {index > 2 && (
                            <span className="text-slate-400 font-mono">{index + 1}</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div
                            className={`font-bold ${
                              isTop5
                                ? 'text-amber-900'
                                : isProjectorMode
                                ? 'text-white'
                                : 'text-slate-900'
                            }`}
                          >
                            {stu.name}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono">
                            {stu.studentCode}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="font-semibold px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200/60 rounded-md">
                            {stu.classId}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                            <CheckCircle2 className="w-3 h-3" />
                            {stu.submissionCount || 0} bài
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center font-bold text-emerald-700 tabular-nums">
                          +{stu.submissionScore || 0}đ
                        </td>
                        <td className="py-3 px-4 text-center font-bold text-indigo-600 tabular-nums">
                          +{stu.gameScore || 0}đ
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-amber-100/80 text-amber-900 font-extrabold text-sm tabular-nums">
                            <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                            {stu.totalScore || 0}đ
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {(stu.badges || []).slice(0, 2).map((b) => (
                              <span
                                key={b.id}
                                className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-md text-[10px] font-semibold"
                              >
                                🏅 {b.name}
                              </span>
                            ))}
                            {latestSub && onOpenSubmissionPreview && (
                              <button
                                onClick={() => onOpenSubmissionPreview(latestSub)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-900 hover:bg-emerald-700 text-white rounded-md text-[10px] font-semibold transition-colors cursor-pointer"
                                title={`Xem bài nộp: ${latestSub.fileName}`}
                              >
                                <Eye className="w-3 h-3" />
                                <span>Xem bài: {latestSub.fileName.slice(0, 18)}</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          {/* TOP 5 HALL OF FAME PODIUM FOR GAMES */}
          <section
            className={`p-6 sm:p-8 rounded-3xl border shadow-lg relative overflow-hidden ${
              isProjectorMode
                ? 'bg-gradient-to-b from-slate-900 to-indigo-950 border-amber-500/30'
                : 'bg-gradient-to-br from-amber-500/10 via-amber-50/40 to-orange-50/30 border-amber-300/80'
            }`}
          >
            <div className="text-center max-w-xl mx-auto mb-6">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/20 text-amber-700 font-extrabold text-xs tracking-wider uppercase mb-2">
                <Sparkles className="w-4 h-4 text-amber-600" />
                <span>VINH DANH THÀNH TÍCH TRÒ CHƠI</span>
              </div>
              <h3
                className={`text-2xl sm:text-3xl font-display font-extrabold ${
                  isProjectorMode ? 'text-white' : 'text-slate-900'
                }`}
              >
                🏆 BẢNG VINH DANH TOP 5 TRÒ CHƠI
              </h3>
              <p
                className={`text-xs mt-1 ${
                  isProjectorMode ? 'text-slate-300' : 'text-slate-600'
                }`}
              >
                Điểm trung bình: <strong>{avgGameScore} điểm</strong> · Hiển thị{' '}
                <strong>{filteredResults.length}</strong> lượt hoàn thành
              </p>
            </div>

            {top5Games.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">
                Chưa có kết quả trò chơi nào được ghi nhận. Hãy cho lớp quét QR để tham gia!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-3.5 items-stretch">
                {top5Games.map((result, idx) => {
                  const rankLabels = ['🥇 TOP 1', '🥈 TOP 2', '🥉 TOP 3', '⭐ TOP 4', '⭐ TOP 5'];
                  const styles = [
                    {
                      card: 'border-2 border-amber-400 bg-gradient-to-b from-amber-50 to-white ring-4 ring-amber-400/20 shadow-lg sm:-translate-y-2',
                      badge: 'bg-amber-500 text-white font-extrabold',
                    },
                    {
                      card: 'border-2 border-slate-300 bg-gradient-to-b from-slate-50 to-white shadow-md',
                      badge: 'bg-slate-600 text-white font-extrabold',
                    },
                    {
                      card: 'border-2 border-amber-700/40 bg-gradient-to-b from-amber-50/50 to-white shadow-md',
                      badge: 'bg-amber-800 text-white font-extrabold',
                    },
                    {
                      card: 'border border-slate-200 bg-white/90 shadow-xs',
                      badge: 'bg-slate-200 text-slate-800 font-bold',
                    },
                    {
                      card: 'border border-slate-200 bg-white/90 shadow-xs',
                      badge: 'bg-slate-200 text-slate-800 font-bold',
                    },
                  ][idx];

                  return (
                    <div
                      key={result.id}
                      className={`p-4 rounded-2xl flex flex-col justify-between text-center transition-all duration-200 ${
                        styles.card
                      } ${isProjectorMode ? 'bg-slate-800/90 text-white' : ''}`}
                    >
                      <div>
                        <div className="flex justify-center mb-2">
                          <span
                            className={`px-3 py-1 rounded-xl text-xs font-display tracking-tight shadow-xs ${styles.badge}`}
                          >
                            {rankLabels[idx]}
                          </span>
                        </div>

                        <div
                          className={`font-display font-extrabold text-base tracking-tight truncate ${
                            isProjectorMode ? 'text-white' : 'text-slate-900'
                          }`}
                          title={result.studentName}
                        >
                          {result.studentName}
                        </div>

                        <div
                          className={`text-xs font-bold mt-0.5 ${
                            isProjectorMode ? 'text-indigo-300' : 'text-emerald-700'
                          }`}
                        >
                          Lớp {result.studentClass}
                        </div>
                      </div>

                      <div
                        className={`mt-3 pt-3 border-t ${
                          isProjectorMode ? 'border-slate-700' : 'border-slate-100'
                        }`}
                      >
                        <div className="text-xl font-black font-display text-emerald-800 tabular-nums">
                          {result.score}đ
                        </div>
                        <div
                          className={`text-[11px] mt-0.5 flex items-center justify-center gap-1.5 ${
                            isProjectorMode ? 'text-slate-400' : 'text-slate-500'
                          }`}
                        >
                          <CheckCircle2 className="w-3 h-3 text-emerald-700" />
                          <span>
                            {result.correctCount}/{result.totalQuestions} câu
                          </span>
                          <span>·</span>
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>{result.timeSpentSeconds}s</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* FULL GAME RANKINGS TABLE */}
          <section
            className={`rounded-2xl border shadow-xs overflow-hidden ${
              isProjectorMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <div
              className={`p-4 border-b flex items-center justify-between text-xs ${
                isProjectorMode
                  ? 'border-slate-800 text-slate-300'
                  : 'border-slate-100 text-slate-700 bg-slate-50'
              }`}
            >
              <div className="font-bold font-display uppercase tracking-wide">
                Bảng Xếp Hạng Trò Chơi ({filteredResults.length} lượt tham gia)
              </div>
              <div className="text-[11px] text-slate-400">
                Tiêu chí: Điểm số cao hơn → Thời gian nhanh hơn
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead
                  className={`border-b font-semibold ${
                    isProjectorMode
                      ? 'bg-slate-800/60 border-slate-700 text-slate-400'
                      : 'bg-slate-50 border-slate-200 text-slate-600'
                  }`}
                >
                  <tr>
                    <th className="py-3 px-4 w-16 text-center">Hạng</th>
                    <th className="py-3 px-4">Học sinh</th>
                    <th className="py-3 px-3">Lớp</th>
                    <th className="py-3 px-4">Trò chơi</th>
                    <th className="py-3 px-4 text-center">Điểm số</th>
                    <th className="py-3 px-4 text-center">Số câu đúng</th>
                    <th className="py-3 px-4 text-center">Thời gian</th>
                    <th className="py-3 px-4 text-right">Thời điểm hoàn thành</th>
                  </tr>
                </thead>
                <tbody
                  className={`divide-y ${
                    isProjectorMode ? 'divide-slate-800' : 'divide-slate-100'
                  }`}
                >
                  {filteredResults.map((res, index) => {
                    const isTop1 = index === 0;
                    const isTop5 = index < 5;
                    return (
                      <tr
                        key={res.id}
                        className={`transition-colors ${
                          isTop1
                            ? isProjectorMode
                              ? 'bg-amber-950/20'
                              : 'bg-amber-50/40'
                            : isProjectorMode
                            ? 'hover:bg-slate-800/50'
                            : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3 px-4 text-center font-bold">
                          {index === 0 && <span className="text-amber-500 font-display">🥇 1</span>}
                          {index === 1 && <span className="text-slate-400 font-display">🥈 2</span>}
                          {index === 2 && <span className="text-amber-700 font-display">🥉 3</span>}
                          {index > 2 && (
                            <span className="text-slate-400 font-mono">{index + 1}</span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-bold">
                          <span
                            className={
                              isTop5
                                ? 'text-amber-800'
                                : isProjectorMode
                                ? 'text-white'
                                : 'text-slate-900'
                            }
                          >
                            {res.studentName}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <span className="font-semibold px-2 py-0.5 bg-slate-100 text-slate-700 rounded-md">
                            {res.studentClass}
                          </span>
                        </td>
                        <td
                          className="py-3 px-4 text-slate-500 max-w-xs truncate"
                          title={res.gameTitle}
                        >
                          {res.gameTitle}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className="font-extrabold text-sm text-emerald-800 tabular-nums">
                            {res.score}
                          </span>
                          <span className="text-[10px] text-slate-400">/{res.maxScore}</span>
                        </td>
                        <td className="py-3 px-4 text-center font-medium tabular-nums text-slate-700">
                          {res.correctCount}/{res.totalQuestions}
                        </td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums text-slate-600">
                          {res.timeSpentSeconds}s
                        </td>
                        <td className="py-3 px-4 text-right text-slate-400 whitespace-nowrap text-[11px]">
                          {new Date(res.completedAt).toLocaleString('vi-VN')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
