-- =============================================================================
-- 0005 · Base de conocimiento y busqueda vectorial
-- =============================================================================
-- Cada tenant tiene sus propios manuales. El filtro por tenant va DENTRO de la
-- consulta vectorial, no despues: de lo contrario el indice HNSW devuelve los k
-- vecinos globales y una empresa terminaria leyendo el manual de otra.
-- =============================================================================

create table public.knowledge_documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  title        varchar(255) not null,
  source_type  varchar(30)  not null default 'manual',  -- manual | pdf | url | faq
  source_url   text,
  storage_path text,
  language     varchar(10)  not null default 'es',
  status       public.document_status not null default 'pending',
  chunk_count  integer not null default 0,
  checksum     text,
  error_text   text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, title)
);

create trigger knowledge_documents_touch
  before update on public.knowledge_documents
  for each row execute function app.touch_updated_at();

create table public.knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  document_id  uuid not null references public.knowledge_documents(id) on delete cascade,
  section_name varchar(255),
  chunk_index  integer not null,
  content      text not null,
  token_count  integer,
  embedding    extensions.vector(1536) not null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- Indice vectorial. vector_cosine_ops porque los embeddings de OpenAI vienen
-- normalizados y la similitud coseno es la metrica correcta para ellos.
create index knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Acompana al indice vectorial para que el filtro por tenant sea barato.
create index knowledge_chunks_tenant_idx on public.knowledge_chunks (tenant_id);

-- -----------------------------------------------------------------------------
-- Busqueda semantica
-- -----------------------------------------------------------------------------
-- Recibe el vector de la consulta ya calculado (el embedding se genera fuera de
-- la base). Devuelve solo fragmentos del tenant indicado y por encima del umbral
-- de similitud: si no hay nada suficientemente parecido, devuelve cero filas y
-- el pipeline escala a un humano en vez de inventar una respuesta.
-- -----------------------------------------------------------------------------

create or replace function public.search_knowledge(
  p_tenant_id  uuid,
  p_embedding  extensions.vector(1536),
  p_match_count integer default 5,
  p_min_similarity double precision default 0.35
)
returns table (
  chunk_id     uuid,
  document_id  uuid,
  title        varchar(255),
  section_name varchar(255),
  content      text,
  similarity   double precision
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select
    kc.id,
    kd.id,
    kd.title,
    kc.section_name,
    kc.content,
    1 - (kc.embedding <=> p_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_documents kd on kd.id = kc.document_id
  where kc.tenant_id = p_tenant_id
    and kd.status = 'indexed'
    and 1 - (kc.embedding <=> p_embedding) >= p_min_similarity
  order by kc.embedding <=> p_embedding
  limit greatest(p_match_count, 1);
$$;

grant execute on function public.search_knowledge(uuid, extensions.vector, integer, double precision)
  to authenticated, service_role;
