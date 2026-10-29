import type { Message } from './types';

let generation = '0';
export function currentGeneration(): string {
  return generation;
}

export function send(msg: Message): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        { ...msg, generation: msg.generation ?? generation },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message ?? 'sendMessage failed'));
          else if (!response || typeof response !== 'object')
            reject(new Error('后台未返回有效响应，请重试'));
          else if (response.type === 'qf.error')
            reject(new Error(response.message || '操作失败'));
          else {
            if (typeof response.generation === 'string')
              generation = response.generation;
            resolve(response);
          }
        },
      );
    } catch (e) {
      reject(e);
    }
  });
}
