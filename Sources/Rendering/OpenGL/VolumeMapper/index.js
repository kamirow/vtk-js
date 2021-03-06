import macro                from 'vtk.js/Sources/macro';
import { vec3, mat3, mat4 } from 'gl-matrix';
import vtkDataArray         from 'vtk.js/Sources/Common/Core/DataArray';
import { VtkDataTypes }     from 'vtk.js/Sources/Common/Core/DataArray/Constants';
import vtkHelper            from 'vtk.js/Sources/Rendering/OpenGL/Helper';
import vtkMath              from 'vtk.js/Sources/Common/Core/Math';
import vtkOpenGLFramebuffer from 'vtk.js/Sources/Rendering/OpenGL/Framebuffer';
import vtkOpenGLTexture     from 'vtk.js/Sources/Rendering/OpenGL/Texture';
import vtkShaderProgram     from 'vtk.js/Sources/Rendering/OpenGL/ShaderProgram';
import vtkVertexArrayObject from 'vtk.js/Sources/Rendering/OpenGL/VertexArrayObject';
import vtkViewNode          from 'vtk.js/Sources/Rendering/SceneGraph/ViewNode';
import { Representation }   from 'vtk.js/Sources/Rendering/Core/Property/Constants';
import { Filter }           from 'vtk.js/Sources/Rendering/OpenGL/Texture/Constants';
import { InterpolationType } from 'vtk.js/Sources/Rendering/Core/VolumeProperty/Constants';

import vtkVolumeVS from 'vtk.js/Sources/Rendering/OpenGL/glsl/vtkVolumeVS.glsl';
import vtkVolumeFS from 'vtk.js/Sources/Rendering/OpenGL/glsl/vtkVolumeFS.glsl';

const { vtkWarningMacro, vtkErrorMacro } = macro;

// ----------------------------------------------------------------------------
// vtkOpenGLVolumeMapper methods
// ----------------------------------------------------------------------------

function vtkOpenGLVolumeMapper(publicAPI, model) {
  // Set our className
  model.classHierarchy.push('vtkOpenGLVolumeMapper');

  publicAPI.buildPass = () => {
    model.zBufferTexture = null;
  };

  // ohh someone is doing a zbuffer pass, use that for
  // intermixed volume rendering
  publicAPI.opaqueZBufferPass = (prepass, renderPass) => {
    if (prepass) {
      const zbt = renderPass.getZBufferTexture();
      if (zbt !== model.zBufferTexture) {
        model.zBufferTexture = zbt;
      }
    }
  };

  // Renders myself
  publicAPI.volumePass = (prepass, renderPass) => {
    if (prepass) {
      model.openGLRenderWindow = publicAPI.getFirstAncestorOfType('vtkOpenGLRenderWindow');
      model.context = model.openGLRenderWindow.getContext();
      model.tris.setContext(model.context);
      model.scalarTexture.setWindow(model.openGLRenderWindow);
      model.scalarTexture.setContext(model.context);
      model.colorTexture.setWindow(model.openGLRenderWindow);
      model.colorTexture.setContext(model.context);
      model.opacityTexture.setWindow(model.openGLRenderWindow);
      model.opacityTexture.setContext(model.context);
      model.lightingTexture.setWindow(model.openGLRenderWindow);
      model.lightingTexture.setContext(model.context);
      model.framebuffer.setWindow(model.openGLRenderWindow);

      model.openGLVolume = publicAPI.getFirstAncestorOfType('vtkOpenGLVolume');
      const actor = model.openGLVolume.getRenderable();
      model.openGLRenderer = publicAPI.getFirstAncestorOfType('vtkOpenGLRenderer');
      const ren = model.openGLRenderer.getRenderable();
      model.openGLCamera = model.openGLRenderer.getViewNodeFor(ren.getActiveCamera());
      publicAPI.renderPiece(ren, actor);
    }
  };

  publicAPI.buildShaders = (shaders, ren, actor) => {
    publicAPI.getShaderTemplate(shaders, ren, actor);
    publicAPI.replaceShaderValues(shaders, ren, actor);
  };

  publicAPI.getShaderTemplate = (shaders, ren, actor) => {
    shaders.Vertex = vtkVolumeVS;
    shaders.Fragment = vtkVolumeFS;
    shaders.Geometry = '';
  };

  publicAPI.replaceShaderValues = (shaders, ren, actor) => {
    let FSSource = shaders.Fragment;

    const iType = actor.getProperty().getInterpolationType();

    // compute the tcoords
    if (iType === InterpolationType.LINEAR) {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ComputeTCoords', [
          'vec2 tpos = getTextureCoord(ijk, 0.0);',
          'vec2 tpos2 = getTextureCoord(ijk, 1.0);',
          'float zmix = ijk.z - floor(ijk.z);',
        ]).result;
    } else {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ComputeTCoords', [
          'vec2 tpos = getTextureCoord(ijk, 0.5);',
        ]).result;
    }

    // compute the scalar value
    if (iType === InterpolationType.LINEAR) {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ScalarFunction', [
          'scalar = getScalarValue(tpos);',
          'float scalar2 = getScalarValue(tpos2);',
          'scalar = mix(scalar, scalar2, zmix);',
        ]).result;
    } else {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ScalarFunction', [
          'scalar = getScalarValue(tpos);',
        ]).result;
    }

    // for lighting and gradient opacity we need the
    // normal texture
    const gopacity = actor.getProperty().getUseGradientOpacity(0);
    if (gopacity || model.lastLightComplexity > 0) {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::Normal::Dec', [
          'uniform sampler2D normalTexture;',
        ]).result;
      if (iType === InterpolationType.LINEAR) {
        FSSource = vtkShaderProgram.substitute(FSSource,
          '//VTK::Normal::Impl', [
            'vec4 normal = texture2D(normalTexture, tpos);',
            'vec4 normal2 = texture2D(normalTexture, tpos2);',
            'normal = mix(normal, normal2, zmix);',
          ]).result;
      } else {
        FSSource = vtkShaderProgram.substitute(FSSource,
          '//VTK::Normal::Impl', [
            'vec4 normal = texture2D(normalTexture,tpos);',
          ]).result;
      }
    }

    // if using gradient opacity apply that
    if (gopacity) {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::GradientOpacity::Dec', [
          'uniform float goscale;',
          'uniform float goshift;',
          'uniform float gomin;',
          'uniform float gomax;',
        ]).result;
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::GradientOpacity::Impl', [
          'tcolor.a = tcolor.a*clamp(normal.a*normal.a*goscale + goshift, gomin, gomax);',
        ]).result;
    }

    // if we had to encode the scalar values into
    // rgb then add the right call to decode them
    // otherwise the generic texture lookup
    const volInfo = model.scalarTexture.getVolumeInfo();
    if (volInfo.encodedScalars) {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ScalarValueFunction::Impl', [
          'vec4 scalarComps = texture2D(texture1, tpos);',
          'return scalarComps.r + scalarComps.g/255.0 + scalarComps.b/65025.0;',
        ]).result;
    } else {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ScalarValueFunction::Impl',
        'return texture2D(texture1, tpos).r;').result;
    }

    // WebGL only supports loops over constants
    // and does not support while loops so we
    // have to hard code how many steps/samples to take
    // We do a break so most systems will gracefully
    // early terminate, but it is always possible
    // a system will execute every step regardless
    FSSource = vtkShaderProgram.substitute(FSSource,
      '//VTK::MaximumSamplesValue',
      `${model.renderable.getMaximumSamplesPerRay()}`).result;

    // if we have a ztexture then declare it and use it
    if (model.zBufferTexture !== null) {
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ZBuffer::Dec', [
          'uniform sampler2D zBufferTexture;',
          'uniform float vpWidth;',
          'uniform float vpHeight;',
        ]).result;
      FSSource = vtkShaderProgram.substitute(FSSource,
        '//VTK::ZBuffer::Impl', [
          'vec4 depthVec = texture2D(zBufferTexture, vec2(gl_FragCoord.x / vpWidth, gl_FragCoord.y/vpHeight));',
          'float zdepth = (depthVec.r*256.0 + depthVec.g)/257.0;',
          'zdepth = zdepth * 2.0 - 1.0;',
          'zdepth = -2.0 * camFar * camNear / (zdepth*(camFar-camNear)-(camFar+camNear)) - camNear;',
          'zdepth = -zdepth/rayDir.z;',
          'tbounds.y = min(zdepth,tbounds.y);',
        ]).result;
    }

    shaders.Fragment = FSSource;

    publicAPI.replaceShaderLight(shaders, ren, actor);
  };

  publicAPI.replaceShaderLight = (shaders, ren, actor) => {
    let FSSource = shaders.Fragment;

    // check for shadow maps
    const shadowFactor = '';

    switch (model.lastLightComplexity) {
      default:
      case 0: // no lighting, tcolor is fine as is
        break;

      case 1:  // headlight
      case 2: // light kit
      case 3: { // positional not implemented fallback to directional
        FSSource = vtkShaderProgram.substitute(FSSource, '//VTK::Light::Dec', [
          'uniform float vSpecularPower;',
          'uniform float vAmbient;',
          'uniform float vDiffuse;',
          'uniform float vSpecular;',
          '//VTK::Light::Dec'], false).result;
        FSSource = vtkShaderProgram.substitute(FSSource,
          '//VTK::Light::Impl',
          [
            '  normal.rgb = 2.0*(normal.rgb - 0.5);',
            '  vec3 diffuse = vec3(0.0, 0.0, 0.0);',
            '  vec3 specular = vec3(0.0, 0.0, 0.0);',
            '  //VTK::Light::Impl',
            '  tcolor.rgb = tcolor.rgb*(diffuse*vDiffuse + vAmbient) + specular*vSpecular;',
          ],
          false,
          ).result;
        let lightNum = 0;
        ren.getLights().forEach((light) => {
          const status = light.getSwitch();
          if (status > 0) {
            FSSource = vtkShaderProgram.substitute(FSSource, '//VTK::Light::Dec', [
              // intensity weighted color
              `uniform vec3 lightColor${lightNum};`,
              `uniform vec3 lightDirectionWC${lightNum}; // normalized`,
              `uniform vec3 lightHalfAngleWC${lightNum}; // normalized`,
              '//VTK::Light::Dec'], false).result;
            FSSource = vtkShaderProgram.substitute(FSSource, '//VTK::Light::Impl', [
//              `  float df = max(0.0, dot(normal.rgb, -lightDirectionWC${lightNum}));`,
              `  float df = abs(dot(normal.rgb, -lightDirectionWC${lightNum}));`,
              `  diffuse += ((df${shadowFactor}) * lightColor${lightNum});`,
              // '  if (df > 0.0)',
              // '    {',
//              `    float sf = pow( max(0.0, dot(lightHalfAngleWC${lightNum},normal.rgb)), specularPower);`,
              `    float sf = pow( abs(dot(lightHalfAngleWC${lightNum},normal.rgb)), vSpecularPower);`,
              `    specular += ((sf${shadowFactor}) * lightColor${lightNum});`,
//              '    }',
              '  //VTK::Light::Impl'],
              false,
              ).result;
            lightNum++;
          }
        });
      }
    }

    shaders.Fragment = FSSource;
  };

  publicAPI.getNeedToRebuildShaders = (cellBO, ren, actor) => {
    // do we need lighting?
    let lightComplexity = 0;
    if (actor.getProperty().getShade()) {
      // consider the lighting complexity to determine which case applies
      // simple headlight, Light Kit, the whole feature set of VTK
      lightComplexity = 0;
      model.numberOfLights = 0;

      ren.getLights().forEach((light) => {
        const status = light.getSwitch();
        if (status > 0) {
          model.numberOfLights++;
          if (lightComplexity === 0) {
            lightComplexity = 1;
          }
        }

        if (lightComplexity === 1
            && (model.numberOfLights > 1
              || light.getIntensity() !== 1.0
              || !light.lightTypeIsHeadLight())) {
          lightComplexity = 2;
        }
        if (lightComplexity < 3
            && (light.getPositional())) {
          lightComplexity = 3;
        }
      });
    }

    let needRebuild = false;
    if (model.lastLightComplexity !== lightComplexity) {
      model.lastLightComplexity = lightComplexity;
      needRebuild = true;
    }

    // has something changed that would require us to recreate the shader?
    if (cellBO.getProgram() === 0 ||
        needRebuild ||
        model.lastZBufferTexture !== model.zBufferTexture ||
        cellBO.getShaderSourceTime().getMTime() < publicAPI.getMTime() ||
        cellBO.getShaderSourceTime().getMTime() < actor.getMTime() ||
        cellBO.getShaderSourceTime().getMTime() < model.currentInput.getMTime()) {
      model.lastZBufferTexture = model.zBufferTexture;
      return true;
    }

    return false;
  };

  publicAPI.updateShaders = (cellBO, ren, actor) => {
    cellBO.getVAO().bind();
    model.lastBoundBO = cellBO;

    // has something changed that would require us to recreate the shader?
    if (publicAPI.getNeedToRebuildShaders(cellBO, ren, actor)) {
      const shaders = { Vertex: null, Fragment: null, Geometry: null };

      publicAPI.buildShaders(shaders, ren, actor);

      // compile and bind the program if needed
      const newShader =
        model.openGLRenderWindow.getShaderCache().readyShaderProgramArray(shaders.Vertex, shaders.Fragment, shaders.Geometry);

      // if the shader changed reinitialize the VAO
      if (newShader !== cellBO.getProgram()) {
        cellBO.setProgram(newShader);
        // reset the VAO as the shader has changed
        cellBO.getVAO().releaseGraphicsResources();
      }

      cellBO.getShaderSourceTime().modified();
    } else {
      model.openGLRenderWindow.getShaderCache().readyShaderProgram(cellBO.getProgram());
    }

    publicAPI.setMapperShaderParameters(cellBO, ren, actor);
    publicAPI.setCameraShaderParameters(cellBO, ren, actor);
    publicAPI.setPropertyShaderParameters(cellBO, ren, actor);
  };

  publicAPI.setMapperShaderParameters = (cellBO, ren, actor) => {
    // Now to update the VAO too, if necessary.
    const program = cellBO.getProgram();

    if (cellBO.getCABO().getElementCount() &&
        (model.VBOBuildTime.getMTime() > cellBO.getAttributeUpdateTime().getMTime() ||
        cellBO.getShaderSourceTime().getMTime() > cellBO.getAttributeUpdateTime().getMTime())) {
      cellBO.getCABO().bind();
      if (program.isAttributeUsed('vertexDC')) {
        if (!cellBO.getVAO().addAttributeArray(program, cellBO.getCABO(),
                                           'vertexDC', cellBO.getCABO().getVertexOffset(),
                                           cellBO.getCABO().getStride(), model.context.FLOAT, 3,
                                           model.context.FALSE)) {
          vtkErrorMacro('Error setting vertexDC in shader VAO.');
        }
      }
    }

    program.setUniformi('texture1',
      model.scalarTexture.getTextureUnit());
    program.setUniformf('sampleDistance',
      model.renderable.getSampleDistance());

    // if we have a zbuffer texture then set it
    if (model.zBufferTexture !== null) {
      program.setUniformi('zBufferTexture',
        model.zBufferTexture.getTextureUnit());
      const size = publicAPI.getRenderTargetSize();
      program.setUniformf('vpWidth', size[0]);
      program.setUniformf('vpHeight', size[1]);
    }
  };

  publicAPI.setCameraShaderParameters = (cellBO, ren, actor) => {
    // // [WMVD]C == {world, model, view, display} coordinates
    // // E.g., WCDC == world to display coordinate transformation
    const keyMats = model.openGLCamera.getKeyMatrices(ren);

    const program = cellBO.getProgram();

    const cam = model.openGLCamera.getRenderable();
    const crange = cam.getClippingRange();
    program.setUniformf('camThick', crange[1] - crange[0]);
    program.setUniformf('camNear', crange[0]);
    program.setUniformf('camFar', crange[1]);

    const bounds = model.currentInput.getBounds();
    const dims = model.currentInput.getDimensions();

    // compute the viewport bounds of the volume
    // we will only render those fragments.
    const pos = vec3.create();
    const dir = vec3.create();
    let dcxmin = 1.0;
    let dcxmax = -1.0;
    let dcymin = 1.0;
    let dcymax = -1.0;
    for (let i = 0; i < 8; ++i) {
      vec3.set(pos, bounds[i % 2],
        bounds[2 + (Math.floor(i / 2) % 2)],
        bounds[4 + Math.floor(i / 4)]);
      vec3.transformMat4(pos, pos, keyMats.wcvc);
      vec3.normalize(dir, pos);

      // now find the projection of this point onto a
      // nearZ distance plane. Since the camera is at 0,0,0
      // in VC the ray is just t*pos and
      // t is -nearZ/dir.z
      // intersection becomes pos.x/pos.z
      const t = -crange[0] / pos[2];
      vec3.scale(pos, dir, t);

      // now convert to DC
      vec3.transformMat4(pos, pos, keyMats.vcdc);

      dcxmin = Math.min(pos[0], dcxmin);
      dcxmax = Math.max(pos[0], dcxmax);
      dcymin = Math.min(pos[1], dcymin);
      dcymax = Math.max(pos[1], dcymax);
    }
    program.setUniformf('dcxmin', dcxmin);
    program.setUniformf('dcxmax', dcxmax);
    program.setUniformf('dcymin', dcymin);
    program.setUniformf('dcymax', dcymax);

    const origin = model.currentInput.getOrigin();
    vec3.set(pos, origin[0], origin[1], origin[2]);
    vec3.transformMat4(pos, pos, keyMats.wcvc);
    program.setUniform3f('vOriginVC', pos[0], pos[1], pos[2]);

    // apply the image directions
    const i2wmat4 = model.currentInput.getIndexToWorld();
    mat4.multiply(model.idxToView, keyMats.wcvc, i2wmat4);

    mat3.copy(model.idxNormalMatrix, model.currentInput.getDirection());
    mat3.multiply(model.idxNormalMatrix, keyMats.normalMatrix,
      model.idxNormalMatrix);

    const ext = model.currentInput.getExtent();
    const spc = model.currentInput.getSpacing();
    const vsize = vec3.create();
    vec3.set(vsize,
      (ext[1] - ext[0]) * spc[0],
      (ext[3] - ext[2]) * spc[1],
      (ext[5] - ext[4]) * spc[2]);
    program.setUniform3f('vSize', vsize[0], vsize[1], vsize[2]);

    const maxSamples = vec3.length(vsize) / model.renderable.getSampleDistance();
    if (maxSamples > model.renderable.getMaximumSamplesPerRay()) {
      vtkWarningMacro(`The number of steps required ${Math.ceil(maxSamples)} is larger than the
        specified maximum number of steps ${model.renderable.getMaximumSamplesPerRay()}.
        Please either change the
        volumeMapper sampleDistance or its maximum number of samples.`);
    }
    const vctoijk = vec3.create();
    vec3.set(vctoijk, dims[0] - 1.0, dims[1] - 1.0, dims[2] - 1.0);
    vec3.divide(vctoijk, vctoijk, vsize);
    program.setUniform3f('vVCToIJK', vctoijk[0], vctoijk[1], vctoijk[2]);

    const volInfo = model.scalarTexture.getVolumeInfo();
    program.setUniformf('texWidth', model.scalarTexture.getWidth());
    program.setUniformf('texHeight', model.scalarTexture.getHeight());
    program.setUniformi('xreps', volInfo.xreps);
    program.setUniformf('xstride', volInfo.xstride);
    program.setUniformf('ystride', volInfo.ystride);
    program.setUniformi('repWidth', volInfo.width);
    program.setUniformi('repHeight', volInfo.height);
    program.setUniformi('repDepth', dims[2]);

    // map normals through normal matrix
    // then use a point on the plane to compute the distance
    const normal = vec3.create();
    const pos2 = vec3.create();
    for (let i = 0; i < 6; ++i) {
      switch (i) {
        default:
        case 0: vec3.set(normal, 1.0, 0.0, 0.0);
          vec3.set(pos2, ext[1], ext[3], ext[5]);
          break;
        case 1: vec3.set(normal, -1.0, 0.0, 0.0);
          vec3.set(pos2, ext[0], ext[2], ext[4]);
          break;
        case 2: vec3.set(normal, 0.0, 1.0, 0.0);
          vec3.set(pos2, ext[1], ext[3], ext[5]);
          break;
        case 3: vec3.set(normal, 0.0, -1.0, 0.0);
          vec3.set(pos2, ext[0], ext[2], ext[4]);
          break;
        case 4: vec3.set(normal, 0.0, 0.0, 1.0);
          vec3.set(pos2, ext[1], ext[3], ext[5]);
          break;
        case 5: vec3.set(normal, 0.0, 0.0, -1.0);
          vec3.set(pos2, ext[0], ext[2], ext[4]);
          break;
      }
      vec3.transformMat3(normal, normal, model.idxNormalMatrix);
      vec3.transformMat4(pos2, pos2, model.idxToView);
      const dist = -1.0 * vec3.dot(pos2, normal);

      // we have the plane in view coordinates
      // specify the planes in view coordinates
      program.setUniform3f(`vPlaneNormal${i}`, normal[0], normal[1], normal[2]);
      program.setUniformf(`vPlaneDistance${i}`, dist);
    }

    const dcvc = mat4.create();
    mat4.invert(dcvc, keyMats.vcdc);
    program.setUniformMatrix('DCVCMatrix', dcvc);

    // handle lighting values
    switch (model.lastLightComplexity) {
      default:
      case 0: // no lighting, tcolor is fine as is
        break;

      case 1:  // headlight
      case 2: // light kit
      case 3: { // positional not implemented fallback to directional
        let lightNum = 0;
        const camDOP = cam.getDirectionOfProjection();
        const lightColor = [];
        ren.getLights().forEach((light) => {
          const status = light.getSwitch();
          if (status > 0) {
            const dColor = light.getDiffuseColor();
            const intensity = light.getIntensity();
            lightColor[0] = dColor[0] * intensity;
            lightColor[1] = dColor[1] * intensity;
            lightColor[2] = dColor[2] * intensity;
            program.setUniform3f(`lightColor${lightNum}`, lightColor);
            const lightDir = light.getDirection();
            program.setUniform3f(`lightDirectionWC${lightNum}`, lightDir);
            const halfAngle = [
              -0.5 * (lightDir[0] + camDOP[0]),
              -0.5 * (lightDir[1] + camDOP[1]),
              -0.5 * (lightDir[2] + camDOP[2])];
            program.setUniform3f(`lightHalfAngleWC${lightNum}`, halfAngle);
            lightNum++;
          }
        });
      }
    }
  };

  publicAPI.setPropertyShaderParameters = (cellBO, ren, actor) => {
    const program = cellBO.getProgram();

    program.setUniformi('ctexture',
      model.colorTexture.getTextureUnit());
    program.setUniformi('otexture',
      model.opacityTexture.getTextureUnit());

    const volInfo = model.scalarTexture.getVolumeInfo();
    const sscale = volInfo.max - volInfo.min;

    const vprop = actor.getProperty();
    const ofun = vprop.getScalarOpacity(0);
    const oRange = ofun.getRange();
    program.setUniformf('oshift', (volInfo.min - oRange[0]) / (oRange[1] - oRange[0]));
    program.setUniformf('oscale', sscale / (oRange[1] - oRange[0]));

    const cfun = vprop.getRGBTransferFunction(0);
    const cRange = cfun.getRange();
    program.setUniformf('cshift', (volInfo.min - cRange[0]) / (cRange[1] - cRange[0]));
    program.setUniformf('cscale', sscale / (cRange[1] - cRange[0]));

    if (vprop.getUseGradientOpacity(0)) {
      const lightingInfo = model.lightingTexture.getVolumeInfo();
      const gomin = vprop.getGradientOpacityMinimumOpacity(0);
      const gomax = vprop.getGradientOpacityMaximumOpacity(0);
      program.setUniformf('gomin', gomin);
      program.setUniformf('gomax', gomax);
      const goRange = [
        vprop.getGradientOpacityMinimumValue(0),
        vprop.getGradientOpacityMaximumValue(0)];
      program.setUniformf('goscale', lightingInfo.max * (gomax - gomin) / (goRange[1] - goRange[0]));
      program.setUniformf('goshift',
        (-goRange[0] * (gomax - gomin) / (goRange[1] - goRange[0])) + gomin);
    }

    if (model.lastLightComplexity > 0 || vprop.getUseGradientOpacity(0)) {
      program.setUniformi('normalTexture',
        model.lightingTexture.getTextureUnit());
    }

    if (model.lastLightComplexity > 0) {
      program.setUniformf('vAmbient', vprop.getAmbient());
      program.setUniformf('vDiffuse', vprop.getDiffuse());
      program.setUniformf('vSpecular', vprop.getSpecular());
      program.setUniformf('vSpecularPower', vprop.getSpecularPower());
    }
  };

  publicAPI.getRenderTargetSize = () => {
    if (model.lastXYF !== 1.0) {
      return model.framebuffer.getSize();
    }
    return model.openGLRenderWindow.getSize();
  };

  publicAPI.renderPieceStart = (ren, actor) => {
    if (model.renderable.getAutoAdjustSampleDistances()) {
      const rwi = ren.getVTKWindow().getInteractor();
      const rft = rwi.getRecentFrameTime();
      if (ren.getVTKWindow().getInteractor().isAnimating()) {
        // compute an estimate for the time it would take to
        // render at full resolution in seconds
        const fvt = rft * model.lastXYF * model.lastXYF;
        model.fullViewportTime = (model.fullViewportTime * 0.75) + (0.25 * fvt);

        // compute target xy factor
        let txyf = Math.sqrt(model.fullViewportTime * rwi.getDesiredUpdateRate());

        // limit subsampling to a factor of 10
        if (txyf > 10.0) {
          txyf = 10.0;
        }
        // only use FBO for reasonable savings (at least 44% (1.2*1.2 - 1.0))
        if (txyf < 1.2) {
          txyf = 1.0;
        }

        model.targetXYF = txyf;
      } else {
        model.targetXYF = Math.sqrt(model.fullViewportTime * rwi.getStillUpdateRate());
      }
      const factor = model.targetXYF / model.lastXYF;
      if (factor > 1.3 || factor < 0.8) {
        model.lastXYF = model.targetXYF;
      }
      if (model.targetXYF < 1.1) {
        model.lastXYF = 1.0;
      }
    } else {
      model.lastXYF = model.renderable.getImageSampleDistance();
    }
    // console.log(`XYF factor set to ${model.lastXYF}`);
    const xyf = model.lastXYF;

    // create/resize framebuffer if needed
    if (xyf !== 1.0) {
      model.framebuffer.saveCurrentBindingsAndBuffers();
      const size = model.openGLRenderWindow.getSize();

      if (model.framebuffer.getGLFramebuffer() === null) {
        model.framebuffer.create(
          Math.floor((size[0] / xyf) + 0.5),
          Math.floor((size[1] / xyf) + 0.5));
        model.framebuffer.populateFramebuffer();
      } else {
        const fbSize = model.framebuffer.getSize();
        if (fbSize[0] !== Math.floor((size[0] / xyf) + 0.5) ||
            fbSize[1] !== Math.floor((size[1] / xyf) + 0.5)) {
          model.framebuffer.create(
            Math.floor((size[0] / xyf) + 0.5),
            Math.floor((size[1] / xyf) + 0.5));
          model.framebuffer.populateFramebuffer();
        }
      }
      model.framebuffer.bind();
      const gl = model.context;
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.colorMask(true, true, true, true);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(0, 0, size[0] / xyf, size[1] / xyf);
    }
    model.context.disable(model.context.DEPTH_TEST);

    // make sure the BOs are up to date
    publicAPI.updateBufferObjects(ren, actor);

    // set interpolation on the texture based on property setting
    const iType = actor.getProperty().getInterpolationType();
    if (iType === InterpolationType.NEAREST) {
      model.scalarTexture.setMinificationFilter(Filter.NEAREST);
      model.scalarTexture.setMagnificationFilter(Filter.NEAREST);
      model.lightingTexture.setMinificationFilter(Filter.NEAREST);
      model.lightingTexture.setMagnificationFilter(Filter.NEAREST);
    } else {
      model.scalarTexture.setMinificationFilter(Filter.LINEAR);
      model.scalarTexture.setMagnificationFilter(Filter.LINEAR);
      model.lightingTexture.setMinificationFilter(Filter.LINEAR);
      model.lightingTexture.setMagnificationFilter(Filter.LINEAR);
    }

    // Bind the OpenGL, this is shared between the different primitive/cell types.
    model.lastBoundBO = null;

    // if we have a zbuffer texture then activate it
    if (model.zBufferTexture !== null) {
      model.zBufferTexture.activate();
    }
  };

  publicAPI.renderPieceDraw = (ren, actor) => {
    const gl = model.context;

    // render the texture
    model.scalarTexture.activate();
    model.opacityTexture.activate();
    model.colorTexture.activate();
    if (actor.getProperty().getShade() ||
        actor.getProperty().getUseGradientOpacity(0)) {
      model.lightingTexture.activate();
    }

    publicAPI.updateShaders(model.tris, ren, actor);

    // First we do the triangles, update the shader, set uniforms, etc.
    gl.drawArrays(gl.TRIANGLES, 0,
      model.tris.getCABO().getElementCount());

    model.scalarTexture.deactivate();
    model.colorTexture.deactivate();
    model.opacityTexture.deactivate();
    if (actor.getProperty().getShade() ||
        actor.getProperty().getUseGradientOpacity(0)) {
      model.lightingTexture.deactivate();
    }
  };

  publicAPI.renderPieceFinish = (ren, actor) => {
    if (model.LastBoundBO) {
      model.LastBoundBO.getVAO().release();
    }

    // if we have a zbuffer texture then deactivate it
    if (model.zBufferTexture !== null) {
      model.zBufferTexture.deactivate();
    }

    if (model.lastXYF !== 1.0) {
      // now copy the frambuffer with the volume into the
      // regular buffer
      model.framebuffer.restorePreviousBindingsAndBuffers();

      if (model.copyShader === null) {
        model.copyShader =
          model.openGLRenderWindow.getShaderCache().readyShaderProgramArray(
            [
              '//VTK::System::Dec',
              'attribute vec4 vertexDC;',
              'varying vec2 tcoord;',
              'void main() { tcoord = vec2(vertexDC.x*0.5 + 0.5, vertexDC.y*0.5 + 0.5); gl_Position = vertexDC; }',
            ].join('\n'),
            [
              '//VTK::System::Dec',
              '//VTK::Output::Dec',
              'uniform sampler2D texture;',
              'varying vec2 tcoord;',
              'void main() { gl_FragData[0] = texture2D(texture,tcoord); }',
            ].join('\n'),
            '');
        const program = model.copyShader;

        model.copyVAO = vtkVertexArrayObject.newInstance();
        model.copyVAO.setContext(model.context);

        model.tris.getCABO().bind();
        if (!model.copyVAO.addAttributeArray(
            program, model.tris.getCABO(),
           'vertexDC', model.tris.getCABO().getVertexOffset(),
            model.tris.getCABO().getStride(), model.context.FLOAT, 3,
           model.context.FALSE)) {
          vtkErrorMacro('Error setting vertexDC in copy shader VAO.');
        }
      } else {
        model.openGLRenderWindow.getShaderCache().readyShaderProgram(model.copyShader);
      }

      const size = model.openGLRenderWindow.getSize();
      model.context.viewport(0, 0, size[0], size[1]);

      // activate texture
      const tex = model.framebuffer.getColorTexture();
      tex.activate();
      model.copyShader.setUniformi('texture',
        tex.getTextureUnit());

      const gl = model.context;
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA,
                       gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // render quad
      model.context.drawArrays(model.context.TRIANGLES, 0,
        model.tris.getCABO().getElementCount());
      tex.deactivate();

      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
                       gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  };

  publicAPI.renderPiece = (ren, actor) => {
    publicAPI.invokeEvent({ type: 'StartEvent' });
    model.renderable.update();
    model.currentInput = model.renderable.getInputData();
    publicAPI.invokeEvent({ type: 'EndEvent' });

    if (model.currentInput === null) {
      vtkErrorMacro('No input!');
      return;
    }

    publicAPI.renderPieceStart(ren, actor);
    publicAPI.renderPieceDraw(ren, actor);
    publicAPI.renderPieceFinish(ren, actor);
  };

  publicAPI.computeBounds = (ren, actor) => {
    if (!publicAPI.getInput()) {
      vtkMath.uninitializeBounds(model.Bounds);
      return;
    }
    model.bounnds = publicAPI.getInput().getBounds();
  };

  publicAPI.updateBufferObjects = (ren, actor) => {
    // Rebuild buffers if needed
    if (publicAPI.getNeedToRebuildBufferObjects(ren, actor)) {
      publicAPI.buildBufferObjects(ren, actor);
    }
  };

  publicAPI.getNeedToRebuildBufferObjects = (ren, actor) => {
    // first do a coarse check
    if (model.VBOBuildTime.getMTime() < publicAPI.getMTime() ||
        model.VBOBuildTime.getMTime() < actor.getMTime() ||
        model.VBOBuildTime.getMTime() < model.renderable.getMTime() ||
        model.VBOBuildTime.getMTime() < actor.getProperty().getMTime() ||
        model.VBOBuildTime.getMTime() < model.currentInput.getMTime()) {
      return true;
    }
    return false;
  };

  publicAPI.buildBufferObjects = (ren, actor) => {
    const image = model.currentInput;

    if (image === null) {
      return;
    }

    const vprop = actor.getProperty();

    // rebuild opacity tfun?
    const ofun = vprop.getScalarOpacity(0);
    const opacityFactor = model.renderable.getSampleDistance() /
      vprop.getScalarOpacityUnitDistance(0);
    let toString = `${ofun.getMTime()}A${opacityFactor}`;
    if (model.opacityTextureString !== toString) {
      const oRange = ofun.getRange();
      const oWidth = 1024;
      const ofTable = new Float32Array(oWidth);
      ofun.getTable(oRange[0], oRange[1], oWidth, ofTable, 1);
      const oTable = new Uint8Array(oWidth);
      for (let i = 0; i < oWidth; ++i) {
        oTable[i] = 255.0 * (1.0 - Math.pow(1.0 - ofTable[i], opacityFactor));
      }
      model.opacityTexture.setMinificationFilter(Filter.LINEAR);
      model.opacityTexture.setMagnificationFilter(Filter.LINEAR);
      model.opacityTexture.create2DFromRaw(oWidth, 1, 1,
        VtkDataTypes.UNSIGNED_CHAR, oTable);
      model.opacityTextureString = toString;
    }

    // rebuild color tfun?
    const cfun = vprop.getRGBTransferFunction(0);
    toString = `${cfun.getMTime()}`;
    if (model.colorTextureString !== toString) {
      const cRange = cfun.getRange();
      const cWidth = 1024;
      const cfTable = new Float32Array(cWidth * 3);
      cfun.getTable(cRange[0], cRange[1], cWidth, cfTable, 1);
      const cTable = new Uint8Array(cWidth * 3);
      for (let i = 0; i < cWidth * 3; ++i) {
        cTable[i] = 255.0 * cfTable[i];
      }
      model.colorTexture.setMinificationFilter(Filter.LINEAR);
      model.colorTexture.setMagnificationFilter(Filter.LINEAR);
      model.colorTexture.create2DFromRaw(cWidth, 1, 3,
        VtkDataTypes.UNSIGNED_CHAR, cTable);
      model.colorTextureString = toString;
    }

    // rebuild the scalarTexture if the data has changed
    toString = `${image.getMTime()}`;
    if (model.scalarTextureString !== toString) {
      // Build the textures
      const dims = image.getDimensions();
      model.scalarTexture.resetFormatAndType();
      model.scalarTexture.create3DOneComponentFromRaw(dims[0], dims[1], dims[2],
        image.getPointData().getScalars().getDataType(),
        image.getPointData().getScalars().getData());
      model.scalarTextureString = toString;
    }

    // rebuild lighting texture
    const shading = vprop.getShade();
    const gopacity = vprop.getUseGradientOpacity(0);
    // rebuild the lightingTexture if the data has changed
    toString = `${image.getMTime()}`;
    if ((shading || gopacity) && model.lightingTextureString !== toString) {
      model.lightingTexture.resetFormatAndType();
      model.lightingTexture.create3DLighting(model.scalarTexture,
        image.getPointData().getScalars().getData(),
        image.getSpacing());
      model.lightingTextureString = toString;
    }

    if (!model.tris.getCABO().getElementCount()) {
      // build the CABO
      const ptsArray = new Float32Array(12);
      for (let i = 0; i < 4; i++) {
        ptsArray[(i * 3)] = ((i % 2) * 2) - 1.0;
        ptsArray[(i * 3) + 1] = (i > 1) ? 1.0 : -1.0;
        ptsArray[(i * 3) + 2] = -1.0;
      }

      const points = vtkDataArray.newInstance({ numberOfComponents: 3, values: ptsArray });
      points.setName('points');

      const cellArray = new Uint16Array(8);
      cellArray[0] = 3;
      cellArray[1] = 0;
      cellArray[2] = 1;
      cellArray[3] = 3;
      cellArray[4] = 3;
      cellArray[5] = 0;
      cellArray[6] = 3;
      cellArray[7] = 2;
      const cells = vtkDataArray.newInstance({ numberOfComponents: 1, values: cellArray });

      model.tris.getCABO().createVBO(cells,
        'polys', Representation.SURFACE,
        { points, cellOffset: 0 });
    }

    model.VBOBuildTime.modified();
  };
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

const DEFAULT_VALUES = {
  context: null,
  VBOBuildTime: null,
  scalarTexture: null,
  scalarTextureString: null,
  opacityTexture: null,
  opacityTextureString: null,
  colorTexture: null,
  colortextureString: null,
  lightingTexture: null,
  lightingTextureString: null,
  tris: null,
  framebuffer: null,
  copyShader: null,
  copyVAO: null,
  lastXYF: 1.0,
  targetXYF: 1.0,
  zBufferTexture: null,
  lastZBufferTexture: null,
  lastLightComplexity: 0,
  fullViewportTime: 1.0,
  idxToView: null,
  idxNormalMatrix: null,
};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  // Inheritance
  vtkViewNode.extend(publicAPI, model, initialValues);

  model.VBOBuildTime = {};
  macro.obj(model.VBOBuildTime, { mtime: 0 });

  model.tris = vtkHelper.newInstance();
  model.scalarTexture = vtkOpenGLTexture.newInstance();
  model.opacityTexture = vtkOpenGLTexture.newInstance();
  model.colorTexture = vtkOpenGLTexture.newInstance();
  model.lightingTexture = vtkOpenGLTexture.newInstance();
  model.framebuffer = vtkOpenGLFramebuffer.newInstance();

  model.idxToView = mat4.create();
  model.idxNormalMatrix = mat3.create();

  // Build VTK API
  macro.setGet(publicAPI, model, [
    'context',
  ]);

  // Object methods
  vtkOpenGLVolumeMapper(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = macro.newInstance(extend, 'vtkOpenGLVolumeMapper');

// ----------------------------------------------------------------------------

export default { newInstance, extend };
