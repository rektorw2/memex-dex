'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Роль текущего пользователя.
 *
 * Читается после монтирования: localStorage недоступен на сервере,
 * и обращение к нему при отрисовке даёт рассинхрон при гидратации.
 *
 * Это подсказка для интерфейса, а не проверка прав. Роль лежит
 * в localStorage и правится за десять секунд из консоли браузера;
 * настоящая проверка живёт на сервере, здесь мы только не показываем
 * то, чем всё равно нельзя воспользоваться.
 */
export function useRole(): { role: string | null; isAdmin: boolean; isLeader: boolean } {
  const [role, setRole] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    setRole(sessionStorage.getItem('accessToken') ? localStorage.getItem('role') : null);
  }, [pathname]);

  return {
    role,
    isAdmin: role === 'ADMIN',
    // Лидер — тот, за кем повторяют. Админ входит сюда же: у него
    // те же возможности плюс управление платформой.
    isLeader: role === 'ADMIN' || role === 'TRADER',
  };
}
