-- ════════════════════════════════════════════════════════
-- UNIKO WAVE — Cache de mapas de ritmo (beatmaps)
-- Cada música do YouTube é analisada UMA vez no mundo e guardada aqui.
-- ════════════════════════════════════════════════════════

create table if not exists public.beatmaps (
  video_id   text primary key,
  beats      jsonb not null,          -- array de tempos (segundos) das batidas reais
  sustains   jsonb,                   -- array paralelo: duração sustentada de cada batida (holds)
  strengths  jsonb,                   -- array paralelo: força do onset (0..1) p/ ênfase/doubles
  duration   double precision,        -- duração da música (segundos)
  source     text,                    -- de onde veio o áudio (cobalt / yt-dlp / playwright)
  created_at timestamptz default now()
);

-- O servidor usa a ANON key; liberamos leitura e escrita nesta tabela de cache.
alter table public.beatmaps enable row level security;

drop policy if exists "beatmaps_select" on public.beatmaps;
create policy "beatmaps_select" on public.beatmaps for select using (true);

drop policy if exists "beatmaps_insert" on public.beatmaps;
create policy "beatmaps_insert" on public.beatmaps for insert with check (true);

drop policy if exists "beatmaps_update" on public.beatmaps;
create policy "beatmaps_update" on public.beatmaps for update using (true) with check (true);
