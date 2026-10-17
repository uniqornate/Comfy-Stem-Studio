export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'];
export const SOURCE_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
export const sourceFilters = [{ name: 'Video or audio', extensions: SOURCE_EXTENSIONS }, { name: 'Video', extensions: VIDEO_EXTENSIONS }, { name: 'Audio', extensions: AUDIO_EXTENSIONS }];
export const audioFilters = [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }];
export const isSourcePath = path => new RegExp(`\.(${SOURCE_EXTENSIONS.join('|')})$`, 'i').test(path);
export const isAudioPath = path => new RegExp(`\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i').test(path);
export const mimeTypes = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };
