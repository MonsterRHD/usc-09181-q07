import { randomUUID } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const newEventId = () => newId('evt');
export const newTransferId = () => newId('trf');
export const newAuthorizationId = () => newId('ath');
export const newInstructionRef = () => newId('ins');
