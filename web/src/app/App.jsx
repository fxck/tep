import React from 'react';
import AppBar from '../chrome/AppBar.jsx';
import VehicleCard from '../chrome/VehicleCard.jsx';
import StopCard from '../chrome/StopCard.jsx';
import Analytics from '../chrome/Analytics.jsx';
import TimeMachine from '../chrome/TimeMachine.jsx';
import CommandPalette from '../chrome/CommandPalette.jsx';
import HelpOverlay from '../chrome/HelpOverlay.jsx';
import Narration from '../chrome/Narration.jsx';
import { useShortcuts } from '../chrome/useShortcuts.js';
import { startThemeEngine } from '../lib/theme.js';

// The React chrome island. Renders OVER the MapLibre canvas (#ui-root is a
// pointer-events:none overlay; each panel re-enables pointer events). The map,
// motion engine and SSE remain pure vanilla in main.js — this layer only reads
// live state from the bridge and dispatches commands back to the engine.
//
// IA: a single unified AppBar (brand · live status · search · 2D/3D · Filters ·
// Layers · Insights · Time Machine · More) replaces the old scattered floating
// islands. Bottom-centre Narration is the ride-along; VehicleCard anchors to the
// selected vehicle; Analytics (Insights) is the right sheet.
export default function App() {
  useShortcuts();
  // Apply the saved/auto theme on load. The visible ThemeToggle lives inside the
  // More popover, so it can't be relied on to mount and apply the theme itself.
  React.useEffect(() => { startThemeEngine(); }, []);
  return (
    <div className="pid-ui">
      <AppBar />
      <VehicleCard />
      <StopCard />
      <Narration />
      <Analytics />
      <TimeMachine />
      <CommandPalette />
      <HelpOverlay />
    </div>
  );
}
