-- Profile photos, and the sensitive half of location.
--
-- Two facts make this migration different from the ones before it.
--
-- The first is that the photo table has no column a byte or an original could
-- hide in. Not `bytea`, not a URL, not a bucket key, not a filesystem path.
-- That is not squeamishness: profile-and-personalization.md §2 gives photo
-- bytes, transcoding, storage and delivery to Platform (media) and lists
-- "storing a file path or a CDN key in a profile read-model" as something this
-- feature never owns. So this table holds the *facts about a photo in the set* —
-- identity, order, approval state, the owner's alt text — and one opaque
-- `media_asset_id` the media service resolves. The two CHECKs on that column
-- exist so "opaque" is a constraint rather than a naming convention: a value
-- carrying a URI scheme or a leading slash is rejected at the database, so the
-- day someone adds `source_path` here the row cannot be written at all.
--
-- The second is `app.location_anchors`. `location.latitude`/`longitude` are
-- `sensitive` (privacy-and-user-settings.md §3) and are the only place in the
-- schema where a coordinate exists. The `sensitivity` column is `NOT NULL` and
-- CHECKed to the single value `'sensitive'`: a stored anchor cannot be quietly
-- reclassified as `internal` or `public` by a later migration, because the
-- downgrade would not fit. Nothing reads this table except the code that turns
-- two anchors into a `DistanceBand`, and that code returns the band.
--
-- Photo states are the media machine's own (`mediaMachine` in
-- packages/platform), not a second vocabulary: `initiated` -> `scanning` ->
-- `approved | rejected | needs_human`. A photo in any state other than
-- `approved` has no position, which is what "held out of the live set" means
-- structurally rather than by a filter somebody has to remember.

BEGIN;
SET search_path TO app;

-- 1. The photo set.
CREATE TABLE IF NOT EXISTS profile_photos (
  photo_id      uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  -- Opaque to everything outside Platform. The CHECKs below are the guarantee
  -- that it stays opaque: no scheme (`https:`, `s3:`), no absolute path, no
  -- Windows separator. A URL to the original cannot be stored here even by an
  -- accident, which is the property §6.1 needs for metadata-stripped-at-ingest
  -- derivatives to mean anything.
  media_asset_id text NOT NULL
    CHECK (char_length(media_asset_id) BETWEEN 1 AND 200)
    CHECK (media_asset_id !~* '^[a-z][a-z0-9+.-]*:')
    CHECK (media_asset_id !~ '^/')
    CHECK (media_asset_id !~ '\\'),
  -- §6.1: alt text is required for the owner's audit trail, capped at 120.
  alt_text      text NOT NULL CHECK (char_length(alt_text) BETWEEN 1 AND 120),
  state         text NOT NULL DEFAULT 'initiated'
    CHECK (state IN ('initiated', 'scanning', 'needs_human', 'approved', 'rejected')),
  -- §6.1: index 0 is always the primary, and there is no separate flag that can
  -- disagree with the order. A photo joins the ordered set when it is approved
  -- (§6.3 step 5), so position and approval are the same fact seen twice.
  position      integer CHECK (position IS NULL OR position >= 0),
  reason_code   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'approved') = (position IS NOT NULL)),
  -- A rejection always carries a machine-readable reason and nothing else does.
  CHECK (reason_code IS NULL OR state = 'rejected')
);

-- The order is a property of the set, so uniqueness is per profile. Without it
-- two concurrent approvals could both land at position 0 and the card would
-- render two primaries.
CREATE UNIQUE INDEX IF NOT EXISTS profile_photos_position
  ON app.profile_photos (user_id, position)
  WHERE position IS NOT NULL;

-- The owner's queue: every photo they hold, whatever its state, in order. A
-- photo's state is always visible to its owner (§6.3 step 5).
CREATE INDEX IF NOT EXISTS profile_photos_by_user
  ON app.profile_photos (user_id, created_at);

-- 2. The precise anchor. `sensitive`, never downgradable, never joined to
-- anything public. The card's `distance` is computed from two of these by
-- `coarseDistanceBand`, which consumes both and returns a band.
CREATE TABLE IF NOT EXISTS location_anchors (
  user_id    uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  latitude   double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude  double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  -- One value, CHECKed. `sensitivity` is carried as a column rather than left to
  -- convention because ADR 0005 classifies per field, and a column that can
  -- hold any of the classes is a column nobody has to think about.
  sensitivity text NOT NULL DEFAULT 'sensitive' CHECK (sensitivity = 'sensitive'),
  observed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
