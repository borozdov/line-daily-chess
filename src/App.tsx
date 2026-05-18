import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from 'react';
import { Chess, Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { AlertTriangle, Check, Copy, Lock, Medal, Radio, Share2, Signal, Trophy } from 'lucide-react';
import {
  DailyPuzzle,
  Leaderboard,
  Profile,
  PuzzleHistoryItem,
  Rank,
  ShareResult,
  UserStats,
  createShareLink,
  fetchDailyPuzzle,
  fetchLeaderboard,
  fetchProfile,
  fetchRank,
  fetchShareResult,
  fetchUserStats,
  submitMove,
  updateProfile,
} from './api';
import { cn } from './lib/utils';

type Notice = {
  kind: 'neutral' | 'good' | 'warn' | 'bad';
  label: string;
  detail: string;
};

type VerboseMove = {
  from: string;
  to: string;
  promotion?: string;
};

type BoardMove = {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
};

type LastMove = {
  from: string;
  to: string;
  role: 'user' | 'system' | 'error';
};

const MOVE_ANIMATION_MS = 240;
const MOVE_SETTLE_MS = MOVE_ANIMATION_MS + 80;

const brandLinks = [
  { label: 'GitHub', href: 'https://github.com/borozdov' },
  { label: 'borozdov.ru', href: 'https://borozdov.ru' },
  { label: 'Telegram', href: 'https://t.me/Borozdov' },
];

const SITE_URL = 'https://daily-puzzle.borozdov.ru';
const DEFAULT_SEO_DESCRIPTION =
  'Линия by Borozdov - ежедневная шахматная задача онлайн: одна сложная тактическая головоломка в день, рейтинг, топ игроков и достижения.';

function BrandStrip() {
  return (
    <div className="brand-strip" aria-label="Borozdov">
      <strong>Borozdov</strong>
      {brandLinks.map((link) => (
        <a key={link.href} href={link.href} rel="noreferrer" target="_blank">
          {link.label}
        </a>
      ))}
    </div>
  );
}

function setMeta(selector: string, create: () => HTMLMetaElement, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = create();
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

function setNamedMeta(name: string, content: string) {
  setMeta(
    `meta[name="${name}"]`,
    () => {
      const element = document.createElement('meta');
      element.setAttribute('name', name);
      return element;
    },
    content,
  );
}

function setPropertyMeta(property: string, content: string) {
  setMeta(
    `meta[property="${property}"]`,
    () => {
      const element = document.createElement('meta');
      element.setAttribute('property', property);
      return element;
    },
    content,
  );
}

function setCanonical(url: string) {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.href = url;
}

function seoForPath(pathname: string) {
  if (pathname === '/top') {
    return {
      title: 'Топ игроков | Линия by Borozdov',
      description: 'Топ игроков Линии by Borozdov: рейтинг по решенным шахматным задачам, стрику, ходам и достижениям.',
      canonical: `${SITE_URL}/top`,
      robots: 'index, follow',
    };
  }

  if (pathname === '/achievements') {
    return {
      title: 'Достижения | Линия by Borozdov',
      description: 'Достижения в Линии by Borozdov: прогресс по решенным задачам, провалам, ходам и месту в топе.',
      canonical: `${SITE_URL}/achievements`,
      robots: 'index, follow',
    };
  }

  if (pathname.startsWith('/stats/') || pathname.startsWith('/r/')) {
    return {
      title: 'Статистика игрока | Линия by Borozdov',
      description: 'Публичная статистика игрока в daily chess puzzle Линия by Borozdov.',
      canonical: `${SITE_URL}${pathname}`,
      robots: 'noindex, follow',
    };
  }

  return {
    title: 'Линия by Borozdov - ежедневная шахматная задача онлайн',
    description: DEFAULT_SEO_DESCRIPTION,
    canonical: `${SITE_URL}/`,
    robots: 'index, follow, max-image-preview:large',
  };
}

function applyRouteSeo(pathname: string) {
  const seo = seoForPath(pathname);
  document.title = seo.title;
  setNamedMeta('description', seo.description);
  setNamedMeta('robots', seo.robots);
  setPropertyMeta('og:title', seo.title);
  setPropertyMeta('og:description', seo.description);
  setPropertyMeta('og:url', seo.canonical);
  setNamedMeta('twitter:title', seo.title);
  setNamedMeta('twitter:description', seo.description);
  setCanonical(seo.canonical);
}

function toUci(source: string, target: string, piece: string) {
  const promotionRank = target[1] === '1' || target[1] === '8';
  const isPawn = piece[1]?.toLowerCase() === 'p';
  return `${source}${target}${promotionRank && isPawn ? 'q' : ''}`;
}

function toBoardMove(uci: string): BoardMove {
  const promotion = uci[4]?.toLowerCase() as BoardMove['promotion'];
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion,
  };
}

function moveUciFromBoard(board: Chess, source: string, target: string) {
  const piece = board.get(source as Square);
  const promotionRank = target[1] === '1' || target[1] === '8';
  const promotion = piece?.type === 'p' && promotionRank ? 'q' : undefined;
  return `${source}${target}${promotion ?? ''}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatCountdown(expiresAt: string) {
  const diff = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function noticeForStatus(status: DailyPuzzle['status']): Notice {
  if (status === 'solved') return { kind: 'good', label: 'РЕШЕНО', detail: 'ЛИНИЯ ЗАВЕРШЕНА' };
  if (status === 'failed') return { kind: 'bad', label: 'ПРОВАЛ', detail: 'ДОСКА ЗАКРЫТА' };
  return { kind: 'neutral', label: 'ИГРАЕМ', detail: 'ХОД ЗА ВАМИ' };
}

function moveStatusLabel(status: string) {
  if (status === 'Solved') return 'РЕШЕНО';
  if (status === 'Brilliant') return 'ВЕРНО';
  if (status === 'Inaccuracy') return 'НЕТОЧНО';
  if (status === 'Blunder') return 'ОШИБКА';
  if (status === 'Locked') return 'ЗАКРЫТО';
  return status.toUpperCase();
}

function shareButtonLabel(state: 'idle' | 'copied' | 'shared') {
  if (state === 'copied') return 'СКОПИРОВАНО';
  if (state === 'shared') return 'ОТПРАВЛЕНО';
  return 'ПОДЕЛИТЬСЯ СТАТИСТИКОЙ';
}

function puzzleStatusLabel(status: PuzzleHistoryItem['status']) {
  return status === 'solved' ? 'РЕШЕНО' : 'ПРОВАЛ';
}

function formatNullable(value: number | string | null | undefined) {
  return value ?? '—';
}

function rankLabel(rank: Rank | null) {
  return rank?.rank ? `#${rank.rank}` : '—';
}

function dailyStateLabel(status: DailyPuzzle['status'] | undefined) {
  if (status === 'solved') return 'РЕШЕНО';
  if (status === 'failed') return 'ЗАКРЫТО';
  return 'ОТКРЫТА';
}

function progressValue(current: number, target: number) {
  return `${Math.min(current, target)}/${target}`;
}

function buildAchievements(stats: UserStats | null, rank: Rank | null) {
  const solved = stats?.solved ?? 0;
  const totalMoves = stats?.total_moves ?? 0;
  const failed = stats?.failed ?? 0;
  const place = rank?.rank ?? null;

  return [
    { group: 'РЕШЕНО', title: '1 ЗАДАЧА', value: progressValue(solved, 1), unlocked: solved >= 1 },
    { group: 'РЕШЕНО', title: '5 ЗАДАЧ', value: progressValue(solved, 5), unlocked: solved >= 5 },
    { group: 'РЕШЕНО', title: '10 ЗАДАЧ', value: progressValue(solved, 10), unlocked: solved >= 10 },
    { group: 'ПРОВАЛЫ', title: '1 ПРОВАЛ', value: progressValue(failed, 1), unlocked: failed >= 1 },
    { group: 'ПРОВАЛЫ', title: '3 ПРОВАЛА', value: progressValue(failed, 3), unlocked: failed >= 3 },
    { group: 'ПРОВАЛЫ', title: '10 ПРОВАЛОВ', value: progressValue(failed, 10), unlocked: failed >= 10 },
    { group: 'ХОДЫ', title: '10 ХОДОВ', value: progressValue(totalMoves, 10), unlocked: totalMoves >= 10 },
    { group: 'ХОДЫ', title: '50 ХОДОВ', value: progressValue(totalMoves, 50), unlocked: totalMoves >= 50 },
    { group: 'ХОДЫ', title: '100 ХОДОВ', value: progressValue(totalMoves, 100), unlocked: totalMoves >= 100 },
    { group: 'ТОП', title: 'ТОП-10', value: place ? `#${place}` : '—', unlocked: Boolean(place && place <= 10) },
    { group: 'ТОП', title: 'ТОП-5', value: place ? `#${place}` : '—', unlocked: Boolean(place && place <= 5) },
    { group: 'ТОП', title: 'ТОП-1', value: place ? `#${place}` : '—', unlocked: place === 1 },
  ];
}

export default function App() {
  const currentPath = useMemo(() => window.location.pathname, []);
  const isLeaderboardPage = useMemo(() => currentPath === '/top', [currentPath]);
  const isAchievementsPage = useMemo(() => currentPath === '/achievements', [currentPath]);
  const shareToken = useMemo(() => {
    const match = currentPath.match(/^\/(?:r|stats)\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }, [currentPath]);
  const [daily, setDaily] = useState<DailyPuzzle | null>(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [rank, setRank] = useState<Rank | null>(null);
  const [game, setGame] = useState<Chess | null>(null);
  const [notice, setNotice] = useState<Notice>({
    kind: 'neutral',
    label: 'СВЯЗЬ',
    detail: 'ПОДКЛЮЧЕНИЕ',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'shared'>('idle');
  const [countdown, setCountdown] = useState('00:00:00');
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalTargets, setLegalTargets] = useState<string[]>([]);
  const [lastMove, setLastMove] = useState<LastMove | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  useEffect(() => {
    applyRouteSeo(currentPath);
  }, [currentPath]);

  const clearSelection = () => {
    setSelectedSquare(null);
    setLegalTargets([]);
  };

  useEffect(() => {
    let mounted = true;

    if (shareToken) {
      fetchShareResult(shareToken)
        .then((payload) => {
          if (!mounted) return;
          setShareResult(payload);
          setNotice({
            kind: payload.status === 'solved' ? 'good' : 'bad',
            label: payload.status === 'solved' ? 'РЕШЕНО' : 'ПРОВАЛ',
            detail: `РЕШЕНО ${payload.stats.solved}/${payload.stats.attempted}`,
          });
        })
        .catch(() => {
          if (!mounted) return;
          setNotice({ kind: 'bad', label: 'ССЫЛКА', detail: 'НЕДЕЙСТВИТЕЛЬНА' });
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });

      return () => {
        mounted = false;
      };
    }

    if (isLeaderboardPage) {
      Promise.all([fetchProfile(), fetchLeaderboard(), fetchRank()])
        .then(([userProfile, globalLeaderboard, userRank]) => {
          if (!mounted) return;
          setProfile(userProfile);
          setNicknameDraft(userProfile.display_name ?? '');
          setLeaderboard(globalLeaderboard);
          setRank(userRank);
          setNotice({ kind: 'neutral', label: 'ТОП', detail: 'ОБЩИЙ РЕЙТИНГ' });
        })
        .catch((error: Error) => {
          if (!mounted) return;
          setNotice({ kind: 'bad', label: 'НЕТ СВЯЗИ', detail: error.message.toUpperCase() });
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });

      return () => {
        mounted = false;
      };
    }

    if (isAchievementsPage) {
      Promise.all([fetchProfile(), fetchUserStats(), fetchRank()])
        .then(([userProfile, userStats, userRank]) => {
          if (!mounted) return;
          setProfile(userProfile);
          setNicknameDraft(userProfile.display_name ?? '');
          setStats(userStats);
          setRank(userRank);
          setNotice({ kind: 'neutral', label: 'ДОСТИЖЕНИЯ', detail: 'ПРОГРЕСС' });
        })
        .catch((error: Error) => {
          if (!mounted) return;
          setNotice({ kind: 'bad', label: 'НЕТ СВЯЗИ', detail: error.message.toUpperCase() });
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });

      return () => {
        mounted = false;
      };
    }

    Promise.all([fetchDailyPuzzle(), fetchUserStats(), fetchProfile(), fetchRank()])
      .then(([payload, userStats, userProfile, userRank]) => {
        if (!mounted) return;
        setDaily(payload);
        setStats(userStats);
        setProfile(userProfile);
        setNicknameDraft(userProfile.display_name ?? '');
        setRank(userRank);
        setGame(new Chess(payload.fen));
        setNotice(noticeForStatus(payload.status));
      })
      .catch((error: Error) => {
        if (!mounted) return;
        const detail = error.message.includes('500') ? 'СЕРВЕР НЕДОСТУПЕН' : error.message.toUpperCase();
        setNotice({ kind: 'bad', label: 'НЕТ СВЯЗИ', detail });
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isAchievementsPage, isLeaderboardPage, shareToken]);

  useEffect(() => {
    if (!daily) return;
    const tick = () => setCountdown(formatCountdown(daily.expires_at_utc));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [daily]);

  useEffect(() => {
    clearSelection();
  }, [daily?.fen, daily?.status]);

  useEffect(() => {
    setLastMove(null);
  }, [daily?.daily_id, daily?.date]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearSelection();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const telemetry = useMemo(() => {
    if (!daily) return [];
    return [['РЕЙТИНГ', daily.rating]];
  }, [daily]);

  const squareStyles = useMemo<Record<string, CSSProperties>>(() => {
    const styles: Record<string, CSSProperties> = {};
    const probe = daily ? new Chess(daily.fen) : null;

    if (lastMove) {
      const tint =
        lastMove.role === 'system'
          ? 'rgba(120, 255, 184, 0.22)'
          : lastMove.role === 'error'
            ? 'rgba(255, 118, 118, 0.24)'
            : 'rgba(255, 255, 255, 0.20)';

      for (const square of [lastMove.from, lastMove.to]) {
        const base = styles[square] ?? {};
        styles[square] = {
          ...base,
          background: `linear-gradient(135deg, ${tint}, rgba(255, 255, 255, 0.03)), ${
            typeof base.background === 'string' ? base.background : 'transparent'
          }`,
          boxShadow: ['inset 0 0 0 3px rgba(255, 255, 255, 0.28)', base.boxShadow]
            .filter(Boolean)
            .join(', '),
        };
      }
    }

    if (selectedSquare) {
      styles[selectedSquare] = {
        background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.12))',
        boxShadow: 'inset 0 0 0 3px rgba(255, 255, 255, 0.64)',
      };
    }

    for (const square of legalTargets) {
      const base = styles[square] ?? {};
      const targetPiece = probe?.get(square as Square);
      const isCapture = Boolean(targetPiece && targetPiece.color !== probe?.turn());

      styles[square] = {
        ...base,
        background: isCapture
          ? typeof base.background === 'string'
            ? base.background
            : 'transparent'
          : 'radial-gradient(circle at center, rgba(12, 12, 10, 0.72) 0 12%, transparent 13%), ' +
            (typeof base.background === 'string' ? base.background : 'transparent'),
        boxShadow: isCapture
          ? [
              'inset 0 0 0 4px rgba(12, 12, 10, 0.76)',
              'inset 0 0 0 7px rgba(255, 255, 255, 0.26)',
              base.boxShadow,
            ]
              .filter(Boolean)
              .join(', ')
          : base.boxShadow,
      };
    }

    return styles;
  }, [daily, lastMove, legalTargets, selectedSquare]);

  const selectSquare = (square: string) => {
    if (!daily || daily.status !== 'playing' || isSubmitting) return;

    const probe = new Chess(daily.fen);
    const piece = probe.get(square as Square);

    if (!piece || piece.color !== probe.turn()) {
      clearSelection();
      return;
    }

    const moves = probe.moves({ square: square as Square, verbose: true }) as VerboseMove[];

    if (!moves.length) {
      clearSelection();
      return;
    }

    setSelectedSquare(square);
    setLegalTargets(moves.map((move) => move.to));
  };

  const handleSquareClick = ({ square }: { square: string }) => {
    if (!daily || daily.status !== 'playing' || isSubmitting) return;

    const probe = new Chess(daily.fen);

    if (selectedSquare === square) {
      clearSelection();
      return;
    }

    if (selectedSquare && legalTargets.includes(square)) {
      const uci = moveUciFromBoard(probe, selectedSquare, square);
      const localMove = probe.move({
        from: selectedSquare as Square,
        to: square as Square,
        promotion: uci[4],
      });

      if (localMove) {
        clearSelection();
        void submitUserMove(`${localMove.from}${localMove.to}${localMove.promotion ?? ''}`);
      }
      return;
    }

    selectSquare(square);
  };

  const submitUserMove = async (uci: string) => {
    if (!daily) return;
    setIsSubmitting(true);
    setShareState('idle');
    setLastMove(null);

    const animationStartedAt = Date.now();
    const optimisticBoard = new Chess(daily.fen);
    let optimisticFen = daily.fen;
    let optimisticMove: { from: string; to: string } | null = null;

    try {
      const move = optimisticBoard.move(toBoardMove(uci));
      if (move) {
        optimisticMove = move;
        optimisticFen = optimisticBoard.fen();
        setGame(new Chess(optimisticFen));
        setLastMove({ from: move.from, to: move.to, role: 'user' });
      }
    } catch {
      // Server-side validation remains authoritative.
    }

    try {
      const response = await submitMove(uci);
      const updated: DailyPuzzle = {
        ...daily,
        fen: response.fen,
        status: response.session_status,
        ply_index: response.ply_index,
        marks: response.marks,
        lives_remaining: response.lives_remaining,
        locked_until: response.locked_until,
      };

      if (optimisticMove) {
        const elapsed = Date.now() - animationStartedAt;
        await sleep(Math.max(0, MOVE_SETTLE_MS - elapsed));
      }

      if (response.system_move_uci) {
        const replyBoard = new Chess(optimisticFen);
        const systemMove = replyBoard.move(toBoardMove(response.system_move_uci));
        if (systemMove) {
          setGame(replyBoard);
          setLastMove({ from: systemMove.from, to: systemMove.to, role: 'system' });
          await sleep(MOVE_SETTLE_MS);
        }
      } else if (response.move_status === 'Inaccuracy') {
        setGame(new Chess(response.fen));
        await sleep(MOVE_SETTLE_MS);
      } else if (response.move_status === 'Blunder' && optimisticMove) {
        setLastMove({ from: optimisticMove.from, to: optimisticMove.to, role: 'error' });
        await sleep(Math.floor(MOVE_ANIMATION_MS * 0.75));
      }

      setDaily(updated);
      setGame(new Chess(response.fen));
      const [userStats, userRank] = await Promise.all([fetchUserStats(), fetchRank()]);
      setStats(userStats);
      setRank(userRank);

      const detail = response.system_move_san
        ? `${response.user_move_san} / ${response.system_move_san}`
        : response.user_move_san ?? response.message;

      setNotice({
        kind:
          response.move_status === 'Brilliant' || response.move_status === 'Solved'
            ? 'good'
            : response.move_status === 'Inaccuracy'
              ? 'warn'
              : 'bad',
        label: moveStatusLabel(response.move_status),
        detail,
      });
    } catch (error) {
      setNotice({
        kind: 'bad',
        label: 'ОТКЛОНЕНО',
        detail: error instanceof Error ? error.message : 'ОШИБКА ХОДА',
      });
      const [payload, userStats, userRank] = await Promise.all([fetchDailyPuzzle(), fetchUserStats(), fetchRank()]);
      setDaily(payload);
      setStats(userStats);
      setRank(userRank);
      setGame(new Chess(payload.fen));
      setLastMove(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const displayName = nicknameDraft.trim();

    if (!displayName) {
      setNotice({ kind: 'warn', label: 'НИК', detail: 'МИНИМУМ 2 СИМВОЛА' });
      return;
    }

    setIsSavingProfile(true);
    try {
      const updatedProfile = await updateProfile(displayName);
      setProfile(updatedProfile);
      setNicknameDraft(updatedProfile.display_name ?? '');
      if (isLeaderboardPage || isAchievementsPage) {
        const [globalLeaderboard, userRank] = await Promise.all([fetchLeaderboard(), fetchRank()]);
        setLeaderboard(globalLeaderboard);
        setRank(userRank);
      }
      setNotice({ kind: 'good', label: 'НИК', detail: updatedProfile.display_name ?? displayName });
    } catch (error) {
      setNotice({
        kind: 'bad',
        label: 'НИК',
        detail: error instanceof Error ? error.message : 'НЕ СОХРАНЕН',
      });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const onDrop = ({
    sourceSquare,
    targetSquare,
    piece,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
    piece: { pieceType: string };
  }) => {
    if (!daily || !game || daily.status !== 'playing' || isSubmitting) return false;
    if (!targetSquare) return false;
    clearSelection();

    const probe = new Chess(daily.fen);
    const promotion = toUci(sourceSquare, targetSquare, piece.pieceType)[4] ?? undefined;
    const localMove = probe.move({
      from: sourceSquare as Square,
      to: targetSquare as Square,
      promotion,
    });

    if (!localMove) return false;

    void submitUserMove(`${localMove.from}${localMove.to}${localMove.promotion ?? ''}`);
    return true;
  };

  const handleShare = async () => {
    if (!daily || daily.status === 'playing' || isSharing) return;
    setIsSharing(true);
    setShareState('idle');

    try {
      const share = await createShareLink();
      const url = new URL(share.path, window.location.origin).toString();

      if (navigator.share) {
        try {
          await navigator.share({ url });
          setShareState('shared');
        } catch {
          await navigator.clipboard.writeText(url);
          setShareState('copied');
        }
      } else {
        await navigator.clipboard.writeText(url);
        setShareState('copied');
      }
    } catch {
      setShareState('idle');
    } finally {
      setIsSharing(false);
    }
  };

  const activeStats = shareResult?.stats ?? stats;
  const visibleHistory = activeStats?.history.slice(0, 5) ?? [];
  const mainHistory = activeStats?.history.slice(0, 3) ?? [];
  const topEntries = leaderboard?.entries ?? [];
  const savedNickname = profile?.display_name ?? '';
  const achievements = buildAchievements(activeStats ?? null, rank);
  const unlockedAchievements = achievements.filter((achievement) => achievement.unlocked).length;
  const isClosed = daily?.status === 'solved' || daily?.status === 'failed';
  const statusKind = daily?.status === 'solved' ? 'good' : daily?.status === 'failed' ? 'bad' : notice.kind;
  const statusLabel = daily?.status === 'solved' ? 'РЕШЕНО' : daily?.status === 'failed' ? 'ПРОВАЛ' : notice.label;
  const profileControl = savedNickname ? (
    <div className="profile-name">
      <span>{savedNickname}</span>
      <Lock className="h-4 w-4" />
    </div>
  ) : (
    <div className="profile-entry">
      <form className="profile-form" onSubmit={handleProfileSubmit}>
        <input
          aria-label="Ник"
          className="profile-input"
          maxLength={24}
          minLength={2}
          placeholder="ВАШ НИК"
          value={nicknameDraft}
          onChange={(event) => setNicknameDraft(event.target.value)}
        />
        <button
          aria-label="Сохранить ник"
          className="profile-save"
          disabled={isSavingProfile || nicknameDraft.trim().length < 2}
          type="submit"
        >
          {isSavingProfile ? <Signal className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        </button>
      </form>
      <span>Один раз, видно в рейтинге</span>
    </div>
  );

  if (isLoading) {
    return (
      <main className="app-shell">
        <div className="boot-panel">
          <Signal className="h-5 w-5" />
          <span>ЗАГРУЗКА ЛИНИИ</span>
        </div>
      </main>
    );
  }

  if (shareToken) {
    return (
      <main className="app-shell">
        <section className="workspace share-workspace">
          <header className="topline">
            <div>
              <p className="eyebrow">СТАТИСТИКА</p>
              <h1>{shareResult?.display_name ?? 'Линия'}</h1>
              <BrandStrip />
            </div>
            <div className="top-actions">
              <a className="nav-button nav-button-primary" href="/">
                НАЧАТЬ РЕШАТЬ
              </a>
              <div className={cn('status-chip', `status-${notice.kind}`)}>
                <Radio className="h-4 w-4" />
                <span>{notice.label}</span>
              </div>
            </div>
          </header>

          <section className="share-result-panel">
            <div className="module module-primary result-module">
              <div className="module-title">
                <span>ПРОФИЛЬ</span>
                <strong>{shareResult?.rank ? `#${shareResult.rank}` : '—'}</strong>
              </div>

              {shareResult ? (
                <>
                  <div className="result-score">
                    <span>МЕСТО В ТОПЕ</span>
                    <strong>{shareResult.rank ? `#${shareResult.rank}` : '—'}</strong>
                  </div>

                  <div className="stats-grid stats-grid-six">
                    <div className="stat-cell">
                      <span>РЕШЕНО</span>
                      <strong>{shareResult.stats.solved}</strong>
                    </div>
                    <div className="stat-cell">
                      <span>ПРОВАЛ</span>
                      <strong>{shareResult.stats.failed}</strong>
                    </div>
                    <div className="stat-cell">
                      <span>ПРОПУСК</span>
                      <strong>{shareResult.stats.skipped}</strong>
                    </div>
                    <div className="stat-cell">
                      <span>СТРИК</span>
                      <strong>{shareResult.stats.current_streak}</strong>
                    </div>
                    <div className="stat-cell">
                      <span>ХОДОВ</span>
                      <strong>{shareResult.stats.total_moves}</strong>
                    </div>
                    <div className="stat-cell">
                      <span>СРЕДНИЙ</span>
                      <strong>{formatNullable(shareResult.stats.average_solved_rating)}</strong>
                    </div>
                  </div>

                  <div className="archive-list">
                    {visibleHistory.length ? (
                      visibleHistory.map((item) => (
                        <div key={`${item.daily_id}-${item.date}`} className={cn('archive-row', `archive-${item.status}`)}>
                          <span>#{item.daily_id}</span>
                          <strong>{puzzleStatusLabel(item.status)}</strong>
                          <em>{item.date}</em>
                          <b>{item.rating}</b>
                        </div>
                      ))
                    ) : (
                      <div className="archive-row archive-empty">
                        <span>—</span>
                        <strong>НЕТ ИСТОРИИ</strong>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className={cn('notice', `notice-${notice.kind}`)}>
                  <span>{notice.label}</span>
                  <strong>{notice.detail}</strong>
                </div>
              )}
            </div>
          </section>
        </section>
      </main>
    );
  }

  if (isLeaderboardPage) {
    return (
      <main className="app-shell">
        <section className="workspace leaderboard-workspace">
          <header className="topline">
            <div>
              <p className="eyebrow">ОБЩИЙ РЕЙТИНГ</p>
              <h1>Топ</h1>
              <BrandStrip />
            </div>
            <div className="top-actions">
              {profileControl}
              <a className="nav-button" href="/">
                НАЗАД К ЗАДАЧЕ
              </a>
              <a className="nav-button" href="/achievements">
                ДОСТИЖЕНИЯ
              </a>
            </div>
          </header>

          <section className="leaderboard-page-panel">
            <div className="module module-primary">
              <div className="module-title">
                <span>ИГРОКИ</span>
                <strong>{rank?.rank ? `ВАШЕ МЕСТО #${rank.rank}` : topEntries.length}</strong>
              </div>
              <div className="leaderboard-page-list">
                <div className="leaderboard-page-row leaderboard-page-head">
                  <span>МЕСТО</span>
                  <strong>НИК</strong>
                  <em>РЕШЕНО</em>
                  <em>ПРОВАЛ</em>
                  <em>ПРОПУСК</em>
                  <em>СТРИК</em>
                  <em>ХОДОВ</em>
                  <em>ДОСТИЖЕНИЯ</em>
                  <em>СРЕДНИЙ</em>
                </div>
                {topEntries.length ? (
                  topEntries.map((entry) => (
                    <div
                      key={entry.guest_id}
                      className={cn('leaderboard-page-row', entry.guest_id === profile?.guest_id && 'leaderboard-current')}
                    >
                      <span>#{entry.rank}</span>
                      <strong title={entry.display_name}>{entry.display_name}</strong>
                      <em>{entry.solved}</em>
                      <em>{entry.failed}</em>
                      <em>{entry.skipped}</em>
                      <em>{entry.current_streak}</em>
                      <em>{entry.total_moves}</em>
                      <em>{entry.achievements}</em>
                      <em>{formatNullable(entry.average_solved_rating)}</em>
                    </div>
                  ))
                ) : (
                  <div className="leaderboard-page-row leaderboard-page-empty">
                    <span>—</span>
                    <strong>ПОКА НЕТ ЗАКРЫТЫХ ЗАДАЧ</strong>
                  </div>
                )}
              </div>
            </div>
          </section>
        </section>
      </main>
    );
  }

  if (isAchievementsPage) {
    return (
      <main className="app-shell">
        <section className="workspace achievements-workspace">
          <header className="topline">
            <div>
              <p className="eyebrow">ПРОГРЕСС</p>
              <h1>Достижения</h1>
              <BrandStrip />
            </div>
            <div className="top-actions">
              {profileControl}
              <a className="nav-button" href="/">
                НАЗАД К ЗАДАЧЕ
              </a>
              <a className="nav-button" href="/top">
                РЕЙТИНГ ИГРОКОВ
              </a>
            </div>
          </header>

          <section className="achievements-panel">
            <div className="module module-primary">
              <div className="module-title">
                <span>МЕСТО</span>
                <strong>{rankLabel(rank)}</strong>
              </div>
              <div className="achievement-summary">
                <div className="stat-cell">
                  <span>ОТКРЫТО</span>
                  <strong>{unlockedAchievements}/{achievements.length}</strong>
                </div>
                <div className="stat-cell">
                  <span>РЕШЕНО</span>
                  <strong>{formatNullable(activeStats?.solved)}</strong>
                </div>
                <div className="stat-cell">
                  <span>ПРОВАЛ</span>
                  <strong>{formatNullable(activeStats?.failed)}</strong>
                </div>
                <div className="stat-cell">
                  <span>ХОДОВ</span>
                  <strong>{formatNullable(activeStats?.total_moves)}</strong>
                </div>
              </div>
            </div>

            <div className="achievement-grid">
              {achievements.map((achievement) => (
                <div
                  key={achievement.title}
                  className={cn('achievement-card', achievement.unlocked && 'achievement-unlocked')}
                >
                  {achievement.unlocked ? <Trophy className="h-5 w-5" /> : <Medal className="h-5 w-5" />}
                  <small>{achievement.group}</small>
                  <span>{achievement.title}</span>
                  <strong>{achievement.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topline">
          <div>
            <p className="eyebrow">ЕЖЕДНЕВНАЯ ЗАДАЧА</p>
            <h1>Линия</h1>
            <BrandStrip />
          </div>
          <div className="top-actions">
            {profileControl}
            <a className="nav-button" href="/top">
              РЕЙТИНГ ИГРОКОВ
            </a>
            <a className="nav-button" href="/achievements">
              ДОСТИЖЕНИЯ
            </a>
            <div className={cn('status-chip', `status-${statusKind}`)}>
              <Radio className="h-4 w-4" />
              <span>{statusLabel}</span>
            </div>
          </div>
        </header>

        <div className="product-grid">
          <section className="board-column" aria-label="Шахматная доска">
            <div className="board-frame">
              {game && daily ? (
                <Chessboard
                  options={{
                    id: 'LineBoard',
                    position: game.fen(),
                    onPieceDrop: onDrop,
                    onSquareClick: handleSquareClick,
                    boardOrientation: daily.board_orientation,
                    squareStyles,
                    darkSquareStyle: { backgroundColor: '#63705f' },
                    lightSquareStyle: { backgroundColor: '#d8d5c8' },
                    boardStyle: {
                      borderRadius: 0,
                      boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.45)',
                    },
                    animationDurationInMs: MOVE_ANIMATION_MS,
                    showAnimations: true,
                    showNotation: false,
                  }}
                />
              ) : (
                <div className="board-empty">
                  <AlertTriangle className="h-6 w-6" />
                  <span>СЕРВЕР НЕДОСТУПЕН</span>
                </div>
              )}

              {daily && daily.status !== 'playing' && (
                <div className="lock-layer">
                  {daily.status === 'solved' ? <Check className="h-10 w-10" /> : <Lock className="h-10 w-10" />}
                  <span>{daily.status === 'solved' ? 'РЕШЕНО' : 'ПРОВАЛ'}</span>
                  <strong>ДО СЛЕДУЮЩЕЙ ЗАДАЧИ {countdown}</strong>
                </div>
              )}

              {isSubmitting && <div className="submit-line" />}
            </div>
          </section>

          <aside className="control-column">
            <section className="module module-primary">
              <div className="module-title">
                <span>ЗАДАЧА</span>
                <strong>#{daily?.daily_id ?? '—'}</strong>
              </div>

              <div className="telemetry-grid">
                {telemetry.map(([label, value]) => (
                  <div key={label} className="metric">
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="module">
              <div className="module-title">
                <span>СТАТИСТИКА</span>
                <strong>{formatNullable(activeStats?.attempted)}</strong>
              </div>
              <div className="stats-grid stats-grid-six">
                <div className="stat-cell">
                  <span>МЕСТО</span>
                  <strong>{rankLabel(rank)}</strong>
                </div>
                <div className="stat-cell">
                  <span>РЕШЕНО</span>
                  <strong>{formatNullable(activeStats?.solved)}</strong>
                </div>
                <div className="stat-cell">
                  <span>ПРОВАЛ</span>
                  <strong>{formatNullable(activeStats?.failed)}</strong>
                </div>
                <div className="stat-cell">
                  <span>ПРОПУСК</span>
                  <strong>{formatNullable(activeStats?.skipped)}</strong>
                </div>
                <div className="stat-cell">
                  <span>СТРИК</span>
                  <strong>{formatNullable(activeStats?.current_streak)}</strong>
                </div>
                <div className="stat-cell">
                  <span>ХОДОВ</span>
                  <strong>{formatNullable(activeStats?.total_moves)}</strong>
                </div>
              </div>
            </section>

            <section className="module rhythm-module">
              <div className="module-title">
                <span>РИТМ</span>
                <strong>ДЕНЬ #{daily?.daily_id ?? '—'}</strong>
              </div>
              <div className="stats-grid stats-grid-three">
                <div className="stat-cell">
                  <span>СЕГОДНЯ</span>
                  <strong>{dailyStateLabel(daily?.status)}</strong>
                </div>
                <div className="stat-cell">
                  <span>СЕРИЯ</span>
                  <strong>{formatNullable(activeStats?.current_streak)}</strong>
                </div>
                <div className="stat-cell">
                  <span>НОВАЯ</span>
                  <strong>{countdown}</strong>
                </div>
              </div>
            </section>

            <section className="module archive-module">
              <div className="module-title">
                <span>АРХИВ</span>
                <strong>{mainHistory.length}</strong>
              </div>
              <div className="archive-list archive-list-compact">
                {mainHistory.length ? (
                  mainHistory.map((item) => (
                    <div key={`${item.daily_id}-${item.date}`} className={cn('archive-row', `archive-${item.status}`)}>
                      <span>#{item.daily_id}</span>
                      <strong>{puzzleStatusLabel(item.status)}</strong>
                      <em>{item.date}</em>
                      <b>{item.rating}</b>
                    </div>
                  ))
                ) : (
                  <div className="archive-row archive-empty">
                    <span>—</span>
                    <strong>ПОКА ПУСТО</strong>
                  </div>
                )}
              </div>
            </section>

            <button
              className="share-button"
              type="button"
              onClick={handleShare}
              disabled={!daily || daily.status === 'playing' || isSharing}
            >
              {isSharing ? (
                <Signal className="h-4 w-4" />
              ) : shareState === 'idle' ? (
                <Share2 className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span>{isSharing ? 'СОЗДАЮ' : shareButtonLabel(shareState)}</span>
            </button>
          </aside>
        </div>
      </section>
    </main>
  );
}
