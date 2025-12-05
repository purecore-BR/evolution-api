import { isBase64, isURL } from 'class-validator';
import mimeTypes from 'mime-types';

import { MediaType } from '../dto/sendMessage.dto';

type MessageKind =
  | 'sticker'
  | 'reaction'
  | 'template'
  | 'buttons'
  | 'list'
  | 'location'
  | 'contact'
  | 'poll'
  | 'status'
  | 'ptv'
  | 'audio'
  | 'media'
  | 'text'
  | 'unknown';

export type MessageAnalysis = {
  fieldNames: string[];
  values: unknown[];
  type: MessageKind;
};

const LONG_STRING_THRESHOLD = 200;
const VIDEO_SIZE_THRESHOLD = 4_000_000;
const AUDIO_SIZE_THRESHOLD = 1_000_000;

const normaliseField = (field: string) => field.toLowerCase();

const messageTypeDetectors: { type: MessageKind; match: (fields: string[], values: unknown[]) => boolean }[] = [
  {
    type: 'sticker',
    match: (fields) => fields.some((f) => normaliseField(f).includes('sticker')),
  },
  {
    type: 'reaction',
    match: (fields) => fields.some((f) => normaliseField(f).includes('reaction')),
  },
  {
    type: 'template',
    match: (fields) =>
      fields.some((f) => ['template', 'components', 'language'].includes(normaliseField(f))),
  },
  {
    type: 'buttons',
    match: (fields) => fields.some((f) => normaliseField(f).includes('buttons')),
  },
  {
    type: 'list',
    match: (fields) =>
      fields.some(
        (f) => normaliseField(f).includes('sections') || normaliseField(f).includes('buttontext'),
      ),
  },
  {
    type: 'location',
    match: (fields) =>
      fields.some((f) => normaliseField(f).includes('latitude')) &&
      fields.some((f) => normaliseField(f).includes('longitude')),
  },
  {
    type: 'contact',
    match: (fields) =>
      fields.some((f) => normaliseField(f).includes('contact')) ||
      fields.some((f) => normaliseField(f).includes('wuid')),
  },
  {
    type: 'poll',
    match: (fields) => fields.some((f) => normaliseField(f).includes('selectablecount')),
  },
  {
    type: 'status',
    match: (fields) =>
      fields.some((f) => normaliseField(f) === 'statusjidlist') ||
      fields.some((f) => normaliseField(f) === 'allcontacts'),
  },
  { type: 'ptv', match: (fields) => fields.some((f) => normaliseField(f).includes('video')) },
  { type: 'audio', match: (fields) => fields.some((f) => normaliseField(f).includes('audio')) },
  {
    type: 'media',
    match: (fields) => fields.some((f) => ['media', 'mediatype', 'mimetype'].includes(normaliseField(f))),
  },
  { type: 'text', match: (fields) => fields.some((f) => normaliseField(f) === 'text') },
];

const detectByValues = (values: unknown[]): MessageKind | undefined => {
  const stringValues = values.filter((value): value is string => typeof value === 'string');

  if (stringValues.some((value) => value.toLowerCase().includes('sticker'))) return 'sticker';
  if (stringValues.some((value) => value.toLowerCase().includes('reaction'))) return 'reaction';
  if (stringValues.some((value) => value.toLowerCase().includes('template'))) return 'template';
  if (stringValues.some((value) => value.toLowerCase().includes('button'))) return 'buttons';
  if (stringValues.some((value) => value.toLowerCase().includes('section'))) return 'list';
  if (stringValues.some((value) => value.toLowerCase().includes('latitude'))) return 'location';
  if (stringValues.some((value) => value.toLowerCase().includes('contact'))) return 'contact';
  if (stringValues.some((value) => value.toLowerCase().includes('selectablecount'))) return 'poll';
  if (stringValues.some((value) => value.toLowerCase().includes('status'))) return 'status';
  if (stringValues.some((value) => value.toLowerCase().includes('video'))) return 'ptv';
  if (stringValues.some((value) => value.toLowerCase().includes('audio'))) return 'audio';
  if (stringValues.some((value) => value.toLowerCase().includes('media'))) return 'media';
  if (stringValues.some((value) => value.toLowerCase().includes('text'))) return 'text';

  return undefined;
};

const collectFieldArrays = (
  payload: unknown,
  prefix = '',
  accumulator: { fieldNames: string[]; values: unknown[] } = { fieldNames: [], values: [] },
) => {
  if (!payload || typeof payload !== 'object') {
    return accumulator;
  }

  Object.entries(payload as Record<string, unknown>).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    accumulator.fieldNames.push(path);
    accumulator.values.push(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        accumulator.fieldNames.push(`${path}[${index}]`);
        accumulator.values.push(item);
        if (item && typeof item === 'object') {
          collectFieldArrays(item, `${path}[${index}]`, accumulator);
        }
      });
    } else if (value && typeof value === 'object') {
      collectFieldArrays(value, path, accumulator);
    }
  });

  return accumulator;
};

export const analyzeMessagePayload = (payload: unknown): MessageAnalysis => {
  const { fieldNames, values } = collectFieldArrays(payload);

  const matchedByField = messageTypeDetectors.find(({ match }) => match(fieldNames, values))?.type;
  const matchedByValue = matchedByField ? matchedByField : detectByValues(values);

  return {
    fieldNames,
    values,
    type: matchedByValue || matchedByField || 'unknown',
  };
};

const inferMediaTypeFromMime = (mimetype?: string | false): MediaType | undefined => {
  if (!mimetype) return undefined;
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  return 'document';
};

export const inferMediaMetadata = (
  body: any,
  analysis: MessageAnalysis,
): Partial<{ mediatype: MediaType; mimetype: string; fileName: string; media: string }> => {
  const metadata: Partial<{ mediatype: MediaType; mimetype: string; fileName: string; media: string }> = {};
  const stringValues = analysis.values.filter((value): value is string => typeof value === 'string');

  const urlCandidate = stringValues.find((value) => isURL(value, { require_tld: false }));
  if (urlCandidate) {
    metadata.media = body.media || urlCandidate;
    const mimetype = mimeTypes.lookup(urlCandidate) || undefined;
    metadata.mimetype = body.mimetype || (mimetype as string | undefined);
    metadata.mediatype = body.mediatype || inferMediaTypeFromMime(mimetype || undefined) || 'document';
    const extension = mimeTypes.extension(mimetype || '') || urlCandidate.split('.').pop();
    if (!body.fileName && extension) {
      metadata.fileName = `media.${extension}`;
    }

    return metadata;
  }

  const base64Candidate = stringValues.find(
    (value) => value.length > LONG_STRING_THRESHOLD && isBase64(value, { allowMime: true }),
  );
  if (base64Candidate) {
    metadata.media = body.media || base64Candidate;
    const lowered = base64Candidate.toLowerCase();

    if (lowered.includes('audio/ogg') || lowered.includes('.ogg')) {
      metadata.mediatype = body.mediatype || 'audio';
      metadata.mimetype = body.mimetype || 'audio/ogg';
      metadata.fileName = body.fileName || 'audio.ogg';
    } else if (lowered.includes('image/jpeg') || lowered.includes('.jpg') || lowered.includes('jpeg')) {
      metadata.mediatype = body.mediatype || 'image';
      metadata.mimetype = body.mimetype || 'image/jpeg';
      metadata.fileName = body.fileName || 'image.jpg';
    } else if (base64Candidate.length > VIDEO_SIZE_THRESHOLD) {
      metadata.mediatype = body.mediatype || 'video';
      metadata.mimetype = body.mimetype || 'video/mp4';
      metadata.fileName = body.fileName || 'video.mp4';
    } else if (base64Candidate.length > AUDIO_SIZE_THRESHOLD) {
      metadata.mediatype = body.mediatype || 'audio';
      metadata.mimetype = body.mimetype || 'audio/mpeg';
      metadata.fileName = body.fileName || 'audio.mp3';
    } else {
      metadata.mediatype = body.mediatype || 'image';
      metadata.mimetype = body.mimetype || 'image/png';
      metadata.fileName = body.fileName || 'image.png';
    }
  }

  return metadata;
};
