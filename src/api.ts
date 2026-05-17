export type Session = {
  guest_id: string;
  token: string;
  display_name: string | null;
};

export type DailyPuzzle = {
  daily_id: number;
  external_id: string;
  date: string;
  fen: string;
  board_orientation: 'white' | 'black';
  rating: number;
  rating_deviation: number;
  popularity: number;
  nb_plays: number;
  themes: string[];
  opening_tags: string[];
  status: 'playing' | 'solved' | 'failed';
  ply_index: number;
  marks: MoveMark[];
  lives_remaining: number;
  locked_until: string | null;
  expires_at_utc: string;
};

export type MoveMark = 'brilliant' | 'inaccuracy' | 'blunder';

export type MoveResponse = {
  move_status: 'Brilliant' | 'Inaccuracy' | 'Blunder' | 'Solved' | 'Locked';
  session_status: DailyPuzzle['status'];
  fen: string;
  ply_index: number;
  marks: MoveMark[];
  lives_remaining: number;
  user_move_san: string | null;
  system_move_uci: string | null;
  system_move_san: string | null;
  locked_until: string | null;
  message: string;
};

export type PuzzleHistoryItem = {
  daily_id: number;
  date: string;
  rating: number;
  status: 'solved' | 'failed';
  moves_played: number;
  correct_moves: number;
  marks: MoveMark[];
};

export type UserStats = {
  attempted: number;
  solved: number;
  failed: number;
  skipped: number;
  current_streak: number;
  best_streak: number;
  last_failed_date: string | null;
  total_moves: number;
  correct_moves: number;
  average_rating: number | null;
  average_solved_rating: number | null;
  hardest_solved: PuzzleHistoryItem | null;
  easiest_solved: PuzzleHistoryItem | null;
  solved_tasks: PuzzleHistoryItem[];
  history: PuzzleHistoryItem[];
};

export type Profile = {
  guest_id: string;
  display_name: string | null;
};

export type LeaderboardEntry = {
  rank: number;
  guest_id: string;
  display_name: string;
  solved: number;
  failed: number;
  skipped: number;
  current_streak: number;
  best_streak: number;
  total_moves: number;
  achievements: number;
  average_solved_rating: number | null;
};

export type Leaderboard = {
  entries: LeaderboardEntry[];
};

export type Rank = {
  rank: number | null;
  total: number;
};

export type ShareLink = {
  path: string;
  token: string;
  status: 'solved' | 'failed';
  stats: UserStats;
  display_name: string;
  rank: number | null;
};

export type ShareResult = {
  status: 'solved' | 'failed';
  stats: UserStats;
  issued_at: number;
  display_name: string;
  rank: number | null;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const TOKEN_KEY = 'line_token';
let sessionPromise: Promise<Session> | null = null;

function token() {
  return localStorage.getItem(TOKEN_KEY);
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = body.detail ?? message;
    } catch {
      // Keep the HTTP status text when the body is not JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function ensureSession(): Promise<Session> {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const currentToken = token();
    const response = await fetch(`${API_BASE}/api/session`, {
      headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
    });
    const session = await readJson<Session>(response);
    localStorage.setItem(TOKEN_KEY, session.token);
    localStorage.setItem('line_guest_id', session.guest_id);
    return session;
  })();

  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = null;
    throw error;
  }
}

export async function fetchDailyPuzzle(): Promise<DailyPuzzle> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/daily`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  return readJson<DailyPuzzle>(response);
}

export async function submitMove(move: string): Promise<MoveResponse> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/move`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ move }),
  });
  return readJson<MoveResponse>(response);
}

export async function fetchUserStats(): Promise<UserStats> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/stats`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  return readJson<UserStats>(response);
}

export async function fetchProfile(): Promise<Profile> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/profile`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  return readJson<Profile>(response);
}

export async function updateProfile(displayName: string): Promise<Profile> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/profile`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ display_name: displayName }),
  });
  return readJson<Profile>(response);
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
  const response = await fetch(`${API_BASE}/api/leaderboard`);
  return readJson<Leaderboard>(response);
}

export async function fetchRank(): Promise<Rank> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/rank`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  return readJson<Rank>(response);
}

export async function createShareLink(): Promise<ShareLink> {
  const session = await ensureSession();
  const response = await fetch(`${API_BASE}/api/share`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  return readJson<ShareLink>(response);
}

export async function fetchShareResult(token: string): Promise<ShareResult> {
  const response = await fetch(`${API_BASE}/api/share/${encodeURIComponent(token)}`);
  return readJson<ShareResult>(response);
}
