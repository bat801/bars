const KNOWN = [
  ['session_required', 'Сессия не привязана к устройству. Войдите снова.'],
  ['session_revoked', 'Сессия завершена. Войдите снова на этом устройстве.'],
  ['session_device_mismatch', 'Сессия принадлежит другому устройству. Войдите снова.'],
  ['session_conflict', 'Сессия уже привязана к другому устройству. Войдите снова.'],
  ['access_denied', 'Доступ к аккаунту закрыт.'],
  ['not_authenticated', 'Сессия истекла. Войдите снова.'],
  ['Auth session missing', 'Сессия истекла. Войдите снова.'],
  ['JWT expired', 'Сессия истекла. Войдите снова.'],
  ['Invalid login credentials', 'Неверная почта или пароль.'],
  ['Email not confirmed', 'Почта не подтверждена. Напишите администратору.'],
  ['User already registered', 'Аккаунт с такой почтой уже существует.'],
  ['New password should be different', 'Новый пароль должен отличаться от текущего.'],
  ['Password should be at least', 'Пароль слишком короткий.'],
  ['Email rate limit exceeded', 'Слишком много попыток. Подождите немного.'],
  ['For security purposes', 'Подождите немного перед повторной попыткой.'],
  ['rate_limited', 'Слишком много сообщений подряд. Подождите несколько секунд.'],
  ['invalid_keys', 'Не удалось подготовить ключи шифрования для отправки.'],
  ['invalid_sender_device', 'Это устройство больше не авторизовано. Перезагрузите страницу.'],
  ['device_conflict', 'Устройство было отозвано. Зарегистрируйте новое устройство.'],
  ['device_revoked', 'Это устройство отозвано. Используйте другое устройство или войдите заново после очистки данных сайта.'],
  ['device_limit', 'Достигнут лимит устройств (20).'],
  ['device_pending', 'Это устройство ожидает подтверждения на другом устройстве.'],
  ['device_pending_limit', 'Слишком много запросов на подключение. Отклоните лишние и попробуйте снова.'],
  ['device_not_found', 'Устройство не найдено.'],
  ['recovery_exists', 'Ключ восстановления уже создан. Используйте существующий файл и парольную фразу.'],
  ['recovery_revoked', 'Этот ключ восстановления отозван. Создайте новый ключ.'],
  ['recovery_mismatch', 'Файл не совпадает с активным ключом восстановления на сервере.'],
  ['recovery_bad_passphrase', 'Неверная парольная фраза для ключа восстановления.'],
  ['recovery_not_found', 'Резервная копия ключа восстановления не найдена на сервере.'],
  ['recovery_weak_passphrase', 'Парольная фраза должна быть не короче 12 символов.'],
  ['recovery_backup_failed', 'Не удалось сохранить резервную копию ключа на сервере.'],
  ['invalid_recovery_kit', 'Файл ключа восстановления повреждён или не подходит.'],
  ['invalid_recovery_key', 'Ключ восстановления повреждён.'],
  ['conversation_not_found', 'Этот диалог недоступен.'],
  ['contact_not_found', 'Этот человек недоступен для личного диалога.'],
  ['invalid_direct_peer', 'Нельзя начать личный диалог с самим собой.'],
  ['direct_conversation_conflict', 'Не удалось создать диалог. Попробуйте ещё раз.'],
  ['message_too_large', 'Сообщение слишком длинное.'],
  ['empty_message', 'Сообщение не может быть пустым.'],
  ['invalid_message_type', 'Этот тип сообщений пока не поддерживается.'],
  ['unsupported_crypto_version', 'Версия шифрования не поддерживается. Обновите приложение.'],
  ['invalid_message', 'Некорректное сообщение.'],
  ['invalid_public_key', 'Некорректный ключ устройства.'],
  ['invalid_device_name', 'Некорректное имя устройства.'],
  ['invalid_display_name', 'Имя должно быть от 1 до 60 символов.'],
  ['invalid_payload', 'Повреждённое сообщение.'],
  ['empty_text', 'Сообщение не может быть пустым.'],
  ['no_recipients', 'Нет доступных устройств для шифрования.'],
  ['secure_context_required', 'Для шифрования нужен HTTPS или localhost.'],
  ['key_storage_failed', 'Не удалось сохранить ключ устройства в браузере.'],
  ['message_conflict', 'Конфликт сообщений. Попробуйте ещё раз.'],
];

const NETWORK_PATTERNS = [
  'Failed to fetch',
  'NetworkError',
  'Load failed',
  'fetch failed',
  'Network request failed',
  'The Internet connection appears to be offline',
];

export function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return (
    error.message ||
    error.error_description ||
    error.error?.message ||
    String(error)
  );
}

export function humanizeError(
  error,
  fallback = 'Что-то пошло не так. Попробуйте ещё раз.',
) {
  // Client-side AppErrors carry a stable code but a developer-facing message,
  // so match the code before scanning message text.
  if (typeof error?.code === 'string') {
    const match = KNOWN.find(([needle]) => needle === error.code);
    if (match) return match[1];
  }

  const text = errorText(error);
  if (!text) return fallback;

  for (const [needle, message] of KNOWN) {
    if (text.includes(needle)) return message;
  }

  if (NETWORK_PATTERNS.some((pattern) => text.includes(pattern))) {
    return 'Нет соединения с сервером. Проверьте интернет и повторите попытку.';
  }

  return fallback;
}

export function isNetworkError(error) {
  const text = errorText(error);
  return NETWORK_PATTERNS.some((pattern) => text.includes(pattern));
}

export class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
  }
}
