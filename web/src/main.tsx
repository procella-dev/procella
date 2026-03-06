import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import './index.css';

import { Layout } from './components/Layout';
import { StackList } from './pages/StackList';
import { StackDetail } from './pages/StackDetail';
import { UpdateDetail } from './pages/UpdateDetail';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<StackList />} />
          <Route path="stacks/:org/:project/:stack" element={<StackDetail />} />
          <Route path="stacks/:org/:project/:stack/updates/:updateID" element={<UpdateDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
