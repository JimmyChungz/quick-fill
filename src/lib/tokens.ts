import type { FieldToken, IdentityToken } from './types';

export const ALL_TOKENS: FieldToken[] = [
  'username', 'current-password', 'new-password',
  'given-name', 'family-name', 'name',
  'email', 'tel', 'organization',
  'street-address', 'address-line1', 'address-line2',
  'city', 'region', 'postal-code', 'country',
];

export const TOKEN_LABEL: Record<FieldToken, string> = {
  username: '用户名',
  'current-password': '当前密码',
  'new-password': '新密码',
  'given-name': '名',
  'family-name': '姓',
  name: '姓名',
  email: '邮箱',
  tel: '电话',
  organization: '组织 / 公司',
  'street-address': '街道地址',
  'address-line1': '地址行 1',
  'address-line2': '地址行 2',
  city: '城市',
  region: '省 / 州',
  'postal-code': '邮编',
  country: '国家',
};

export const AUTOCOMPLETE_MAP: Record<string, FieldToken> = {
  username: 'username',
  email: 'email',
  tel: 'tel',
  'tel-national': 'tel',
  name: 'name',
  'given-name': 'given-name',
  'family-name': 'family-name',
  organization: 'organization',
  'street-address': 'street-address',
  'address-line1': 'address-line1',
  'address-line2': 'address-line2',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postal-code',
  country: 'country',
  'current-password': 'current-password',
  'new-password': 'new-password',
};

export const TYPE_MAP: Record<string, FieldToken> = {
  email: 'email',
  tel: 'tel',
  // NOTE: `password` is deliberately NOT mapped here. A password input carries
  // no intent by itself: `type=password name=newPassword` is a sign-up field and
  // `type=password` alone is a current-password field. Mapping the type first
  // made every password field a "current password". The heuristic pass runs
  // first (see detectField step 5) and `current-password` is only the fallback.
};

export function isIdentityToken(t: FieldToken): t is IdentityToken {
  return t !== 'username' && t !== 'current-password' && t !== 'new-password';
}
