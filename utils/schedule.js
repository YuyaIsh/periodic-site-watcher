/**
 * スケジュール計算ユーティリティ
 * 
 * options.js と service-worker.js の両方で使用される
 * スケジュール計算関数を共通化する。
 */

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
 * @param {number} [schedule.minute] - hourlyの場合の分（0-59）
 * @param {string} [schedule.at] - daily/weeklyの場合の時刻（'HH:MM'）
 * @param {number} [schedule.dow] - weeklyの場合の曜日（0=日曜）
 * @returns {number} 次回実行時刻（epoch ms）
 */
function computeNextRunAfterSuccess(now, schedule) {
  const date = new Date(now);
  
  if (schedule.type === 'hourly') {
    date.setMinutes(schedule.minute, 0, 0);
    // 既に過ぎている場合は次時間に回す（毎時同じ分に実行するため）
    if (date.getTime() <= now) {
      date.setHours(date.getHours() + 1);
    }
    return date.getTime();
  } else if (schedule.type === 'daily') {
    const [hours, minutes] = schedule.at.split(':').map(Number);
    date.setHours(hours, minutes, 0, 0);
    // 今日の時刻を過ぎている場合は翌日に設定
    if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  } else if (schedule.type === 'weekly') {
    const [hours, minutes] = schedule.at.split(':').map(Number);
    const currentDay = date.getDay();
    const targetDay = schedule.dow;
    // 今週の該当日までの日数を計算（負の値にならないよう+7してから%7）
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    
    date.setHours(hours, minutes, 0, 0);
    // 今日が該当日だが時刻を過ぎている場合は来週に設定
    if (daysToAdd === 0 && date.getTime() <= now) {
      daysToAdd = 7;
    }
    date.setDate(date.getDate() + daysToAdd);
    return date.getTime();
  }
  
  // 未知のスケジュールタイプの場合は1時間後を返す（フォールバック）
  return now + 60 * 60 * 1000;
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

