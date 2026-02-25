/**
 * Base map style with fallback support for style-specific overrides.
 */
(function () {
  const BASELINE_METERS_PER_PIXEL = 20.051116030296317;

  const DEFAULT_COLORS = {
    backgroundFill: '#cccccc',
    waterFill: '#e8e8e8',
    parkFill: '#d7d7d7',
    sidewalkAreaFill: '#b9b9b9',
    buildingFill: '#ffffff',
    buildingStroke: '#ffffff',
    roadStroke: '#a6a6a6',
    railwayStroke: '#7d7d7d',
    tramStroke: '#6b6b6b',
    sidewalkStroke: '#a6a6a6',
    stairsStroke: '#a6a6a6'
  };

  const STYLE_OVERRIDES = (window.__ARCHISVG_STYLE_OVERRIDES =
    window.__ARCHISVG_STYLE_OVERRIDES || {});

  window.registerArchisvgStyle = function registerArchisvgStyle(name, overrideConfig) {
    if (!name) return;
    STYLE_OVERRIDES[String(name).toLowerCase()] = overrideConfig || {};
  };

  function getStyleConfig(styleName) {
    const key = String(styleName || 'default').toLowerCase();
    const override = STYLE_OVERRIDES[key] || {};
    return {
      colors: {
        ...DEFAULT_COLORS,
        ...(override.colors || {})
      }
    };
  }

  function isSidewalk(props) {
    if (props.footway === 'sidewalk') return true;
    if (props.highway === 'footway') return true;
    if (props.highway === 'path' && props.footway === 'sidewalk') return true;
    return false;
  }

  function isStairs(props) {
    return props.highway === 'steps';
  }

  function isRailway(props) {
    return Boolean(props.railway);
  }

  function isTramOverlay(props) {
    return props.render_as_tram_overlay === 'yes';
  }

  function isTram(props) {
    return props.railway === 'tram' || props.tram === 'yes';
  }

  function isAreaGeometry(feature) {
    const type = feature && feature.geometry && feature.geometry.type;
    return type === 'Polygon' || type === 'MultiPolygon';
  }

  function isSidewalkOrPlazaArea(feature) {
    const props = (feature && feature.properties) || {};
    if (!isAreaGeometry(feature)) return false;

    if (props['area:highway'] === 'footway' || props['area:highway'] === 'pedestrian') return true;
    if (props.highway === 'pedestrian' && props.area === 'yes') return true;
    if (props.place === 'square') return true;
    return false;
  }

  function pxFromMeters(widthMeters, metersPerPixel) {
    const mpp = metersPerPixel > 0 ? metersPerPixel : BASELINE_METERS_PER_PIXEL;
    return widthMeters / mpp;
  }

  function roadWidthMeters(props) {
    const kind = props.highway;
    if (!kind) return 2.406133923635558;
    if (kind === 'motorway' || kind === 'trunk') return 5.213290167877042;
    if (kind === 'primary') return 4.0102232060592635;
    if (kind === 'secondary') return 3.208178564847411;
    if (kind === 'tertiary') return 2.606645083938521;
    if (kind === 'residential' || kind === 'unclassified') return 2.0051116030296318;
    return 1.6040892824237054;
  }

  function railwayWidthMeters(props) {
    if (isTram(props)) return 1.203066961817779;
    return 1.403578122120742;
  }

  function featureStyle(feature, metersPerPixel, colors) {
    const props = (feature && feature.properties) || {};
    if (isSidewalkOrPlazaArea(feature)) {
      return { fill: colors.sidewalkAreaFill, stroke: 'none', strokeWidth: 0 };
    }
    if (props.natural === 'water' || props.waterway) {
      return { fill: colors.waterFill, stroke: 'none', strokeWidth: 0 };
    }
    if (props.leisure === 'park' || props.landuse === 'grass' || props.natural === 'grassland') {
      return { fill: colors.parkFill, stroke: 'none', strokeWidth: 0 };
    }
    if (props.building) {
      return {
        fill: colors.buildingFill,
        stroke: colors.buildingStroke,
        strokeWidth: pxFromMeters(0.441124552666519, metersPerPixel)
      };
    }
    if (isSidewalk(props)) {
      const dashPx = pxFromMeters(2.2056227633325947, metersPerPixel);
      return {
        fill: 'none',
        stroke: colors.sidewalkStroke,
        strokeWidth: pxFromMeters(0.9023002213633342, metersPerPixel),
        strokeDasharray: `${dashPx},${dashPx}`
      };
    }
    if (isStairs(props)) {
      const dashPx = pxFromMeters(2.2056227633325947, metersPerPixel);
      return {
        fill: 'none',
        stroke: colors.stairsStroke,
        strokeWidth: pxFromMeters(0.9023002213633342, metersPerPixel),
        strokeDasharray: `${dashPx},${dashPx}`
      };
    }
    if (isTramOverlay(props)) {
      return {
        fill: 'none',
        stroke: colors.tramStroke,
        strokeWidth: pxFromMeters(railwayWidthMeters(props), metersPerPixel),
        strokeDasharray: null
      };
    }
    if (props.highway) {
      return {
        fill: 'none',
        stroke: colors.roadStroke,
        strokeWidth: pxFromMeters(roadWidthMeters(props), metersPerPixel),
        strokeDasharray: null
      };
    }
    if (isRailway(props)) {
      return {
        fill: 'none',
        stroke: isTram(props) ? colors.tramStroke : colors.railwayStroke,
        strokeWidth: pxFromMeters(railwayWidthMeters(props), metersPerPixel),
        strokeDasharray: null
      };
    }
    return null;
  }

  window.createMapStyle = function createMapStyle(styleName, renderContext) {
    const config = getStyleConfig(styleName);
    const colors = config.colors;
    window.STYLE_DEFAULT_COLORS = colors;

    const metersPerPixel =
      renderContext && typeof renderContext.metersPerPixel === 'number'
        ? renderContext.metersPerPixel
        : BASELINE_METERS_PER_PIXEL;

    return {
      paintOrder(feature) {
        const props = (feature && feature.properties) || {};
        if (isTramOverlay(props)) return 380;
        if (isTram(props) && !props.highway) return 375;
        if (isRailway(props)) return 370;
        if (isStairs(props)) return 360;
        if (isSidewalk(props)) return 350;
        if (props.highway) return 300;
        if (props.building) return 200;
        if (props.landuse === 'grass') return 140;
        if (isSidewalkOrPlazaArea(feature)) return 130;
        if (props.leisure === 'park') return 100;
        if (props.natural === 'water' || props.waterway) return 90;
        return -1;
      },
      fillColoring(feature) {
        const s = featureStyle(feature, metersPerPixel, colors);
        return s ? s.fill : 'none';
      },
      strokeColoring(feature) {
        const s = featureStyle(feature, metersPerPixel, colors);
        return s ? s.stroke : 'none';
      },
      strokeWidth(feature) {
        const s = featureStyle(feature, metersPerPixel, colors);
        return s ? s.strokeWidth : 0;
      },
      strokeDasharray(feature) {
        const s = featureStyle(feature, metersPerPixel, colors);
        return s ? s.strokeDasharray : null;
      }
    };
  };
})();
