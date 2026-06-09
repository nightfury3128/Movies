const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_URL = 'https://image.tmdb.org/t/p';

export class TmdbProvider {
  constructor({ apiKey, accessToken, language = 'en-US' } = {}) {
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.language = language;
  }

  get configured() {
    return Boolean(this.apiKey || this.accessToken);
  }

  status() {
    return {
      provider: 'tmdb',
      configured: this.configured,
      authMode: this.accessToken ? 'access_token' : this.apiKey ? 'api_key' : null,
    };
  }

  async search(query) {
    if (!this.configured || !query) return [];
    const [movies, shows] = await Promise.all([
      this._get('/search/movie', { query, include_adult: 'false' }),
      this._get('/search/tv', { query, include_adult: 'false' }),
    ]);
    return [
      ...(movies.results ?? []).slice(0, 10).map(item => this._movieSummary(item)),
      ...(shows.results ?? []).slice(0, 10).map(item => this._showSummary(item)),
    ];
  }

  async trending(kind) {
    if (!this.configured) return [];
    const mediaType = kind === 'series' ? 'tv' : 'movie';
    const data = await this._get(`/trending/${mediaType}/week`);
    return (data.results ?? []).slice(0, 20).map(item => mediaType === 'movie' ? this._movieSummary(item) : this._showSummary(item));
  }

  async fetch({ externalId, mediaType }) {
    if (!this.configured) throw new Error('TMDB provider is not configured');
    if (mediaType === 'movie') {
      const data = await this._get(`/movie/${externalId}`, { append_to_response: 'credits,release_dates' });
      return this._movieDetails(data);
    }
    const data = await this._get(`/tv/${externalId}`, { append_to_response: 'credits,content_ratings,external_ids' });
    return this._showDetails(data);
  }

  async _get(path, params = {}) {
    const url = new URL(`${TMDB_BASE_URL}${path}`);
    url.searchParams.set('language', this.language);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    if (this.apiKey && !this.accessToken) url.searchParams.set('api_key', this.apiKey);

    const response = await fetch(url, {
      headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
    });
    if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
    return response.json();
  }

  _movieSummary(item) {
    return {
      contentId: `tmdb_movie_${item.id}`,
      type: 'movie',
      title: item.title ?? item.original_title,
      description: item.overview ?? '',
      year: yearFromDate(item.release_date),
      rating: rating(item.vote_average),
      runtime: '',
      genres: [],
      maturity: 'NR',
      match: Math.round((item.vote_average ?? 0) * 10),
      artwork: artwork(item),
      sourceRefs: [{ source: 'tmdb', id: String(item.id), mediaType: 'movie' }],
    };
  }

  _showSummary(item) {
    return {
      contentId: `tmdb_show_${item.id}`,
      type: 'series',
      title: item.name ?? item.original_name,
      description: item.overview ?? '',
      year: yearFromDate(item.first_air_date),
      rating: rating(item.vote_average),
      runtime: '',
      genres: [],
      maturity: 'NR',
      match: Math.round((item.vote_average ?? 0) * 10),
      artwork: artwork(item),
      sourceRefs: [{ source: 'tmdb', id: String(item.id), mediaType: 'series' }],
    };
  }

  _movieDetails(data) {
    return {
      ...this._movieSummary(data),
      runtime: runtime(data.runtime),
      genres: (data.genres ?? []).map(genre => genre.name),
      maturity: movieCertification(data.release_dates),
      cast: cast(data.credits),
    };
  }

  _showDetails(data) {
    return {
      ...this._showSummary(data),
      runtime: runtime((data.episode_run_time ?? [])[0]),
      genres: (data.genres ?? []).map(genre => genre.name),
      maturity: showCertification(data.content_ratings),
      seasons: data.number_of_seasons,
      episodes: (data.seasons ?? [])
        .filter(season => season.season_number > 0)
        .flatMap(season => Array.from({ length: season.episode_count ?? 0 }, (_, index) => ({
          contentId: `tmdb_show_${data.id}_s${String(season.season_number).padStart(2, '0')}e${String(index + 1).padStart(2, '0')}`,
          title: `Episode ${index + 1}`,
          season: season.season_number,
          episode: index + 1,
          runtime: runtime((data.episode_run_time ?? [])[0]),
        }))),
      cast: cast(data.credits),
    };
  }
}

function artwork(item) {
  return [
    item.poster_path ? { kind: 'poster', source: 'tmdb', url: `${TMDB_IMAGE_URL}/w780${item.poster_path}` } : null,
    item.backdrop_path ? { kind: 'backdrop', source: 'tmdb', url: `${TMDB_IMAGE_URL}/w1280${item.backdrop_path}` } : null,
  ].filter(Boolean);
}

function yearFromDate(date) {
  return date ? Number(String(date).slice(0, 4)) : new Date().getFullYear();
}

function rating(value) {
  return value ? Number(value).toFixed(1) : 'NR';
}

function runtime(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function cast(credits) {
  return (credits?.cast ?? []).slice(0, 12).map(person => ({
    name: person.name,
    character: person.character,
    profile: person.profile_path ? `${TMDB_IMAGE_URL}/w185${person.profile_path}` : null,
  }));
}

function movieCertification(releaseDates) {
  const us = releaseDates?.results?.find(entry => entry.iso_3166_1 === 'US');
  return us?.release_dates?.find(entry => entry.certification)?.certification || 'NR';
}

function showCertification(contentRatings) {
  const us = contentRatings?.results?.find(entry => entry.iso_3166_1 === 'US');
  return us?.rating || 'NR';
}
