import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Journal · Meditations',
    loadComponent: () =>
      import('./features/journal/journal').then((module) => module.JournalComponent),
  },
  {
    path: 'reflections',
    title: 'Reflections · Meditations',
    loadComponent: () =>
      import('./features/reflections/reflections').then((module) => module.ReflectionsComponent),
  },
  {
    path: 'library',
    title: 'Library · Meditations',
    loadComponent: () =>
      import('./features/library/library').then((module) => module.LibraryComponent),
  },
  {
    path: 'profile',
    title: 'Profile · Meditations',
    loadComponent: () =>
      import('./features/profile/profile').then((module) => module.ProfileComponent),
  },
  { path: '**', redirectTo: '' },
];
