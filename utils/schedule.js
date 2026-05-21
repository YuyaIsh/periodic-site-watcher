/**
 * スケジュール計算ユーティリティ
 *
 * options.js と service-worker.js の両方で使用される
 * スケジュール計算関数を共通化する。
 */

/**
 * @param {Object} schedule
 * @returns {number} 1-23、不正値は 1
 */
function normalizeScheduleEvery(schedule) {
  const e = schedule?.every;
  if (typeof e !== 'number' || !Number.isInteger(e) || e < 1 || e > 23) {
    return 1;
  }
  return e;
}

/**
 * refTime 以降の最初のスロット（every=1 相当）
 *
 * @param {number} refTime
 * @param {Object} schedule
 * @returns {number}
 */
function computeNextSlotFrom(refTime, schedule) {
  const date = new Date(refTime);

  if (schedule.type === 'hourly') {
    date.setMinutes(schedule.minute ?? 0, 0, 0);
    date.setSeconds(0, 0);
    if (date.getTime() <= refTime) {
      date.setHours(date.getHours() + 1);
    }
    return date.getTime();
  }

  if (schedule.type === 'daily') {
    const [hours, minutes] = (schedule.at || '00:00').split(':').map(Number);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= refTime) {
      date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  }

  if (schedule.type === 'weekly') {
    const [hours, minutes] = (schedule.at || '00:00').split(':').map(Number);
    const currentDay = date.getDay();
    const targetDay = schedule.dow ?? 0;
    let daysToAdd = (targetDay - currentDay + 7) % 7;

    date.setHours(hours, minutes, 0, 0);
    if (daysToAdd === 0 && date.getTime() <= refTime) {
      daysToAdd = 7;
    }
    date.setDate(date.getDate() + daysToAdd);
    return date.getTime();
  }

  return refTime + 60 * 60 * 1000;
}

/**
 * スロット形状を保ったまま every × 周期だけ進める
 *
 * @param {number} slotTime
 * @param {Object} schedule
 * @param {number} every
 * @returns {number}
 */
function advanceSlotBy(slotTime, schedule, every) {
  const date = new Date(slotTime);

  if (schedule.type === 'hourly') {
    date.setHours(date.getHours() + every);
    return date.getTime();
  }

  if (schedule.type === 'daily') {
    date.setDate(date.getDate() + every);
    return date.getTime();
  }

  if (schedule.type === 'weekly') {
    date.setDate(date.getDate() + every * 7);
    return date.getTime();
  }

  return slotTime + every * 60 * 60 * 1000;
}

/**
 * 成功時の次回実行時刻を計算する
 *
 * 設計書の「not-before」方式に従い、指定されたスケジュールに基づいて
 * 「この時刻以降なら実行してよい」という時刻を返す。
 * PCスリープ等で遅れても、次回起床で実行可能になるように設計されている。
 *
 * @param {number} now - 現在時刻（epoch ms）
 * @param {Object} schedule - スケジュール設定
 * @param {string} schedule.type - 'hourly' | 'daily' | 'weekly'
 * @param {number} [schedule.every] - 実行間隔（1-23、省略時 1）
 * @param {number} [schedule.minute] - hourlyの場合の分（0-59）
 * @param {string} [schedule.at] - daily/weeklyの場合の時刻（'HH:MM'）
 * @param {number} [schedule.dow] - weeklyの場合の曜日（0=日曜）
 * @param {Object} [context]
 * @param {'initial'|'after-success'} [context.mode='after-success']
 * @param {number} [context.previousNextRun] - 実行前の state.nextRun
 * @param {'schedule'|'manual'} [context.invokedBy='schedule']
 * @param {boolean} [context.resyncSlot=false] - 失敗リトライ成功後に slot 基準へ戻す
 * @returns {number} 次回実行時刻（epoch ms）
 */
function computeNextRunAfterSuccess(now, schedule, context = {}) {
  if (context.mode === 'initial' || context.resyncSlot) {
    return computeNextSlotFrom(now, schedule);
  }

  const every = normalizeScheduleEvery(schedule);
  const invokedBy = context.invokedBy === 'manual' ? 'manual' : 'schedule';

  let anchor;
  if (invokedBy === 'manual') {
    anchor = computeNextSlotFrom(now, schedule);
  } else {
    anchor = context.previousNextRun;
    if (typeof anchor !== 'number' || !Number.isFinite(anchor)) {
      anchor = computeNextSlotFrom(now, schedule);
    }
  }

  let next = advanceSlotBy(anchor, schedule, every);
  while (next <= now) {
    next = advanceSlotBy(next, schedule, every);
  }
  return next;
}

/**
 * 失敗時の次回実行時刻を計算する
 *
 * 設計書に従い、失敗時は常に1時間後に再試行する。
 * retryに分単位設定を持たないことで、誤解と複雑化を避けている。
 *
 * @param {number} now - 現在時刻（epoch ms）
 * @returns {number} 次回実行時刻（now + 1時間）
 */
function computeNextRunAfterFail(now) {
  return now + 60 * 60 * 1000;
}
