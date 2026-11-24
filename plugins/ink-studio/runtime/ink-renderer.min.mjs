var Nf=Object.create;var zc=Object.defineProperty;var Of=Object.getOwnPropertyDescriptor;var Uf=Object.getOwnPropertyNames;var Gf=Object.getPrototypeOf,$f=Object.prototype.hasOwnProperty;var mo=(e,t)=>()=>{try{return t||e((t={exports:{}}).exports,t),t.exports}catch(o){throw t=0,o}};var jf=(e,t,o,s)=>{if(t&&typeof t=="object"||typeof t=="function")for(let i of Uf(t))!$f.call(e,i)&&i!==o&&zc(e,i,{get:()=>t[i],enumerable:!(s=Of(t,i))||s.enumerable});return e};var _o=(e,t,o)=>(o=e!=null?Nf(Gf(e)):{},jf(t||!e||!e.__esModule?zc(o,"default",{value:e,enumerable:!0}):o,e));var Pc=mo((ud,xo)=>{var Cc=(()=>{let e=i=>i&&Object.getPrototypeOf(i)===Object.prototype;function t(i){if(!Number.isFinite(i)||i<0||i>1)throw new RangeError("Coverage filter sharpness must be between 0 and 1");return 1-i}function o(i){if(i===void 0||i===!1)return null;let r=i===!0?{}:i;if(!e(r)||Object.keys(r).some(u=>u!=="sharpness"&&u!=="materials"))throw new TypeError("Coverage filter needs a boolean or an object with sharpness and materials");let{sharpness:c=0,materials:l={}}=r;if(!e(l)||Object.keys(l).length>256)throw new TypeError("Coverage filter needs a map of up to 256 material names");let d=new Map(Object.entries(l).map(([u,m])=>{if(!u.trim())throw new TypeError("Coverage filter material names must be nonempty");return[u,t(m)]})),n=t(c);return!n&&![...d.values()].some(Boolean)?null:{fallback:n,varied:d.size>0||n!==1,at:u=>u==null?n:d.get(String(u))??n}}function s(i,r,c,l,d,n){let{color:u,alpha:m,w:p,matte:_}=c;for(let w=0;w<d;w++)for(let y=0;y<l;y++){let F=w*l+y,T=(d-1-w)*l+y,f=w*2*p+y*2,x=(d*2-1-w*2)*p+y*2,E=n?.[F]??1;if(!E)continue;let R=r?r[T]/255:1,C=i[F*3]*R,V=i[F*3+1]*R,q=i[F*3+2]*R,g=R,b=0;for(let A=0;A<4;A++){let I=A&1,ae=A>>1,W=f+I+ae*p,Z=x+I-ae*p,S=Math.min(E,_?.[W]??1)*.25,k=m?m[Z]/255:1,M=S*k/255;C+=u[W*3]*M,V+=u[W*3+1]*M,q+=u[W*3+2]*M,g+=S*(k-R),b+=S}let z=R*b,v=g>1e-6?1/g:0;i[F*3]=(C-i[F*3]*z)*v,i[F*3+1]=(V-i[F*3+1]*z)*v,i[F*3+2]=(q-i[F*3+2]*z)*v,r&&(r[T]=Math.round(Math.min(1,Math.max(0,g))*255))}}return Object.freeze({prepare:o,filter:s})})();typeof xo<"u"&&xo.exports?xo.exports=Cc:globalThis[Symbol.for("ink-studio.coverage-filter")]=Cc});var Hc=mo((md,zn)=>{var Wc=(()=>{let e=Uint8Array.of(137,80,78,71,13,10,26,10),t=new Uint32Array(256);for(let c=0;c<256;c++){let l=c;for(let d=0;d<8;d++)l=l&1?3988292384^l>>>1:l>>>1;t[c]=l>>>0}function o(c,l){let d=new Uint8Array(l.length+12),n=new DataView(d.buffer);n.setUint32(0,l.length);for(let m=0;m<4;m++)d[4+m]=c.charCodeAt(m);d.set(l,8);let u=4294967295;for(let m=4;m<d.length-4;m++)u=t[(u^d[m])&255]^u>>>8;return n.setUint32(d.length-4,(u^4294967295)>>>0),d}function s(c,l,d,n=1){let u=c*n;if(d.length!==u*l)throw new Error("PNG pixel count does not match its shape");let m=new Uint8Array((u+1)*l);for(let p=0;p<l;p++)m.set(d.subarray(p*u,(p+1)*u),p*(u+1)+1);return m}function i(c,l,d,n,u){let m=new Uint8Array(13),p=new DataView(m.buffer);p.setUint32(0,c),p.setUint32(4,l),m[8]=8,m[9]=3;let _=[e,o("IHDR",m),o("PLTE",d)];return n&&_.push(o("tRNS",n)),_.push(o("IDAT",u),o("IEND",new Uint8Array(0))),_}function r(c,l,d){let n=new Uint8Array(13),u=new DataView(n.buffer);return u.setUint32(0,c),u.setUint32(4,l),n[8]=8,n[9]=6,[e,o("IHDR",n),o("IDAT",d),o("IEND",new Uint8Array(0))]}return Object.freeze({chunk:o,scanlines:s,indexed:i,rgba:r})})();typeof zn<"u"?zn.exports=Wc:globalThis[Symbol.for("ink-studio.png-bytes")]=Wc});var Yc=mo((_d,Mn)=>{var Kc=(()=>{let e=38*Math.PI/180,t=24,o=Number.isFinite,s=(g,b)=>{if(!g)throw new RangeError("Camera lens: "+b)},i=g=>o(g)&&g>0&&g<Math.PI;function r(g,b=t){s(o(g)&&g>0&&o(b)&&b>0,"focal length and sensor height must be positive millimeters");let z=2*Math.atan(b/2/g);return s(i(z),"lens must have a representable vertical field of view"),z}function c(g,b=t){s(i(g)&&o(b)&&b>0,"invalid field of view or sensor height");let z=b/2/Math.tan(g/2);return s(o(z)&&z>0,"lens must have a representable focal length"),z}function l(g={},b={}){let z=b.sensorHeight??g.sensorHeight??t;s(o(z)&&z>0,"sensor height must be positive millimeters"),b.fov!==void 0&&b.focalLength!==void 0&&s(Math.abs(b.fov-r(b.focalLength,z))<1e-10,"choose field of view or focal length");let v=g.fov??(g.focalLength!==void 0?r(g.focalLength,g.sensorHeight):e),A=b.fov??v;b.focalLength!==void 0?A=r(b.focalLength,z):b.sensorHeight!==void 0&&b.fov===void 0&&(A=r(c(v,g.sensorHeight),z)),s(i(A),"vertical field of view must be in (0, pi)");let I=b.focusDistance??g.focusDistance;return s(I===void 0||o(I)&&I>0,"focus distance must be positive"),{fov:A,sensorHeight:z,focalLength:c(A,z),...I!==void 0&&{focusDistance:I}}}function d(g={},...b){let z={target:[0,0,0],dist:12,yaw:0,pitch:0,...g,...l(g)};for(let v of b)if(v){let A=l(z,v);z={...z,...v,...A},v.projection!==void 0&&v.ortho===void 0&&(z.ortho=v.projection==="orthographic")}return z.ortho===void 0&&(z.ortho=z.projection==="orthographic"),s(Array.isArray(z.target)&&z.target.length===3&&z.target.every(o)&&[z.yaw,z.pitch,z.dist].every(o)&&z.dist>0,"finite target, orbit and positive distance required"),z.target=z.target.slice(),z.composition!==void 0&&(z.composition=n(z.composition).slice()),z}function n(g){return s(Array.isArray(g)&&g.length===2&&g.every(b=>o(b)&&b>=0&&b<=1),"composition is a normalized screen point [u,v]"),g}function u(g,b){if(s(o(b)&&b>0,"aspect must be positive"),!g.composition)return g.target;let[z,v]=n(g.composition),A=g.dist*Math.tan(g.fov/2),I=Math.sin(g.yaw),ae=Math.cos(g.yaw),W=Math.sin(g.pitch),Z=Math.cos(g.pitch),S=[ae,0,-I],k=[-W*I,Z,-W*ae],M=(.5-z)*2*A*b,K=(v-.5)*2*A;return g.target.map((P,L)=>P+S[L]*M+k[L]*K)}let m=(g,b)=>g[0]*b[0]+g[1]*b[1]+g[2]*b[2],p=(g,b)=>[g[1]*b[2]-g[2]*b[1],g[2]*b[0]-g[0]*b[2],g[0]*b[1]-g[1]*b[0]];function _(g){let b=v=>Array.isArray(v)&&v.length===3&&v.every(o);s(g&&[g.eye,g.right,g.up,g.back].every(b),"pose requires a finite eye and camera axes");let z=[g.right,g.up,g.back];return s(z.every(v=>Math.abs(m(v,v)-1)<1e-4)&&Math.abs(m(z[0],z[1]))<1e-4&&Math.abs(m(z[0],z[2]))<1e-4&&Math.abs(m(z[1],z[2]))<1e-4&&m(p(z[0],z[1]),z[2])>.9999,"pose axes must be right-handed and orthonormal"),Object.fromEntries(["eye","right","up","back"].map(v=>[v,g[v].slice()]))}function w(g){return s(g&&g.length===16&&Array.from(g).every(o),"view matrix must be finite"),_({eye:[-(g[0]*g[12]+g[1]*g[13]+g[2]*g[14]),-(g[4]*g[12]+g[5]*g[13]+g[6]*g[14]),-(g[8]*g[12]+g[9]*g[13]+g[10]*g[14])],right:[g[0],g[4],g[8]],up:[g[1],g[5],g[9]],back:[g[2],g[6],g[10]]})}function y(g){let{eye:b,right:z,up:v,back:A}=_(g);return[z[0],v[0],A[0],0,z[1],v[1],A[1],0,z[2],v[2],A[2],0,-m(z,b),-m(v,b),-m(A,b),1]}function F(g,b=0){s(o(b),"camera setback must be finite");let z=_(g);return z.eye=z.eye.map((v,A)=>v-z.back[A]*b),z}function T(g,b,{setback:z=0}={}){let v=F(g,z),A=b.translation??[0,0,0],I=b.rotation??[0,0,0];s([A,I].every(K=>Array.isArray(K)&&K.length===3&&K.every(o)),"camera motion requires finite world translation and rotation vectors");let ae=Math.hypot(...I);s(o(ae),"rotation magnitude must be finite");let W=ae?I.map(K=>K/ae):[0,0,1],Z=Math.cos(ae),S=Math.sin(ae);function k(K){let P=p(W,K),L=m(W,K)*(1-Z);return K.map((N,H)=>N*Z+P[H]*S+W[H]*L)}let M=k(v.back);return{eye:v.eye.map((K,P)=>K+A[P]+M[P]*z),right:k(v.right),up:k(v.up),back:M}}let f=(g,b,z)=>Math.max(b,Math.min(z,g));function x(g,b){if(!b)return g;let{yaw:z,pitch:v,dist:A}=g;if(b.yaw&&b.yaw[1]-b.yaw[0]<2*Math.PI){let I=(b.yaw[0]+b.yaw[1])/2,ae=z-I,W=I+Math.atan2(Math.sin(ae),Math.cos(ae));z+=f(W,...b.yaw)-W}return b.pitch&&(v=f(v,...b.pitch)),b.distance&&(A=f(A,...b.distance)),{...g,yaw:z,pitch:v,dist:A}}function E(g,b,z,v){let A=Math.sin(g),I=Math.cos(g),ae=Math.cos(b),W=ae<0?-1:1,Z=[ae*A,Math.sin(b),ae*I],S=[W*I,0,-W*A];return{eye:v.map((k,M)=>k+z*Z[M]),right:S,up:p(Z,S),back:Z}}function R(g,b,z){let v=g.slice();for(let A=0;A<2;A++){let I=z[0]*g[A]+z[1]*g[4+A]+z[2]*g[8+A]+g[12+A];v[A+12]+=Math.round(I*b)/b-I}return v}function C(g,b,z,v,A=1){let I=Z=>Z===!0?{snap:!0}:Z||{},{snap:ae,anchor:W=[0,0,0]}={...I(z),...I(v)};return!g.ortho||!ae||v===!1?g.view:(s(Array.isArray(W)&&W.length===3&&Array.from(W).every(o),"snap anchor must be finite XYZ"),R(g.view,b/(2*g.tangent*g.dist*A),W))}function V(g,b,z,v,{orbit:A,impulse:I,probe:ae=!1}={}){s([z,v].every(le=>o(le)&&le>0),"viewport must be positive");let W=b.cameraTime??(b.timeDomains??g.timeDomains)?.read("camera").sampleTime??b.time??b.t??g.lookSnapshot?.time,Z=W??0,S=g.cameraRig?.sample(Z,{shot:b.cameraShot}).camera,k=d(g.cam,S,ae?void 0:b.camera),K=l(k,Object.fromEntries((ae?["fov"]:["fov","focalLength","sensorHeight","focusDistance"]).filter(le=>b[le]!==void 0).map(le=>[le,b[le]]))),P=b.lensScale??1,L=b.zoom??1;s(o(P)&&P>0&&o(L)&&L>0,"lens scale and zoom must be positive");let N=Math.tan(K.fov/2)/P,H=z/v,pe=b.ortho??(b.projection===void 0?k.ortho:b.projection==="orthographic"),de=b.lockCamera?void 0:g.anim,ye=b.dist??k.dist/L,Y=ae?void 0:b.cameraOrbitOffset;Y!==void 0&&(s(Array.isArray(Y)&&Y.length===2&&Array.from(Y).every(o),"orbit offset needs two finite angles"),s(!k.pose||!Y.some(Boolean),"orbit offset requires an orbit-authored camera"));let D=Y?.[0]??0,_e=Y?.[1]??0,{yaw:Se,pitch:Ae,dist:B}=x({yaw:(b.yaw??k.yaw)+D,pitch:(b.pitch??k.pitch)+_e,dist:ye/(de?.zoom||1)},A);s([Se,Ae,B].every(o)&&B>0,"finite orbit and positive distance required");let se=!(b.target&&Object.hasOwn(b.target,"framebuffer"))&&b.target!=null?b.target:k.target;s((Array.isArray(se)||ArrayBuffer.isView(se))&&se.length===3&&Array.from(se).every(o),"target must be finite XYZ");let j=u({target:Array.from(se),yaw:Se,pitch:Ae,dist:B,fov:2*Math.atan(N),composition:b.composition??k.composition},H).map((le,Re)=>le+(de?.kick?.[Re]??0)),X=g.radius??14,G=pe&&!S&&!k.pose?2*X+4:0,Q=B+G,be=k.pose??E(Se,Ae,Q,j),ge=!ae&&I?.(g,{...b,cameraTime:W},F(be,G));return ge&&(ge.translation.some(Boolean)||ge.rotation.some(Boolean))&&(be=T(be,ge,{setback:G})),{base:k,lens:K,time:Z,motion:ge||null,pose:be,view:y(be),framed:j,yaw:Se,pitch:Ae,dist:B,dist0:ye,distance:Q,radius:X,setback:G,aspect:H,tangent:N,ortho:pe,clipNear:Math.max(.4,.15*B),clipFar:400}}function q(g,b,z,v,A,I){let ae=b.slice(),W=[0,0,0],Z={origin:ae,direction:W,axial:1};return(S,k)=>{let M=(S-z/2)/A,K=(k-v/2)/A;Z.axial=I?1:1/Math.hypot(M,K,1);for(let P=0;P<3;P++){let L=P*4,N=M*g[L]+K*g[L+1];ae[P]=b[P]+(I?N:0),W[P]=I?-g[L+2]:(N-g[L+2])*Z.axial}return Z}}return Object.freeze({rays:q,defaultFov:e,defaultSensorHeight:t,fieldOfView:r,focalLength:c,resolve:l,view:d,composition:n,target:u,pose:_,fromView:w,matrix:y,listenerPose:F,applyMotion:T,constrain:x,orbitPose:E,frame:V,snapView:R,artView:C})})();typeof Mn<"u"?Mn.exports=Kc:globalThis[Symbol.for("ink-studio.camera-lens")]=Kc});var Jc=mo((yd,Cn)=>{var Qc=(()=>{let e=Number.isFinite,t=2*Math.PI,o=()=>[0,0,0],s={eye:[0,0,0],right:[1,0,0],up:[0,1,0],back:[0,0,1]},i=(S,k)=>{if(!S)throw new TypeError("Camera impulses: "+k)},r=S=>S&&typeof S=="object"&&!Array.isArray(S)&&[Object.prototype,null].includes(Object.getPrototypeOf(S)),c=(S,k)=>r(S)&&Object.keys(S).every(M=>k.includes(M)),l=S=>typeof S=="string"&&/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,95}$/.test(S)&&!["__proto__","prototype","constructor"].includes(S),d=S=>Array.isArray(S)&&S.length===3&&S.every(k=>e(k)&&Math.abs(k)<=1e6),n=(S,k,M)=>e(S)&&S>=k&&S<=M,u=S=>Math.hypot(...S),m=(S,k)=>S.map(M=>M*k),p=(S,k)=>S.reduce((M,K,P)=>M+K*k[P],0),_=(S,k)=>[S[1]*k[2]-S[2]*k[1],S[2]*k[0]-S[0]*k[2],S[0]*k[1]-S[1]*k[0]],w=(S,k)=>S.map((M,K)=>M-k[K]),y=(S,k=[0,0,1])=>u(S)>1e-10?m(S,1/u(S)):k.slice(),F=S=>(S=Math.max(0,Math.min(1,S)),S*S*(3-2*S)),T=S=>(S&&typeof S=="object"&&(Object.values(S).forEach(T),Object.freeze(S)),S);function f(S,k=0){return i(k<=32,"data nesting budget exceeded"),Array.isArray(S)?S.map(M=>f(M,k+1)):r(S)?Object.fromEntries(Object.entries(S).filter(([,M])=>M!==void 0).map(([M,K])=>[M,f(K,k+1)])):(i(S===null||typeof S=="string"||typeof S=="boolean"||e(S),"expected finite JSON data"),S)}function x(S,k){let M=S>>>0;for(let K of String(k))M=Math.imul(M^K.charCodeAt(0),16777619)>>>0;return M}function E(S,k){let M=(Math.imul(S|0,374761393)^k)>>>0;return M=Math.imul(M^M>>>13,1274126177),((M^M>>>16)>>>0)/4294967295*2-1}function R(S,k){let M=Math.floor(S),K=F(S-M);return E(M,k)*(1-K)+E(M+1,k)*K}function C(S=s){i(r(S)&&[S.eye,S.right,S.up,S.back].every(d),"expected an unshaken eye and orthonormal camera basis");let k=[S.right,S.up,S.back];return i(k.every(M=>Math.abs(u(M)-1)<1e-4)&&Math.abs(p(k[0],k[1]))<1e-4&&Math.abs(p(k[0],k[2]))<1e-4&&Math.abs(p(k[1],k[2]))<1e-4&&p(_(k[0],k[1]),k[2])>.9999,"camera basis must be right-handed and orthonormal"),S}function V(S,k){return[0,1,2].map(M=>S[0]*k.right[M]+S[1]*k.up[M]+S[2]*k.back[M])}function q(S){if(S===void 0||S===!1)return null;i(c(S,["inner","outer","power"]),"invalid distance falloff");let{inner:k=0,outer:M=20,power:K=2}=S;return i(n(k,0,1e6)&&n(M,0,1e6)&&M>k&&n(K,.05,16),"falloff needs increasing radii and a positive power"),{inner:k,outer:M,power:K}}function g(S,k,M,K){i(c(S,["id","time","duration","translation","rotation","space","direction","source","falloff","propagationSpeed","frequency","damping","attack","release","profile","weight","seed","lever","angularGain","enabled"]),"unknown impulse field");let{id:P=k,time:L=M,duration:N=.7,translation:H=[0,0,0],rotation:pe=[0,0,0],space:de="camera",direction:ye,source:Y,propagationSpeed:D=0,frequency:_e=12,damping:Se=7,attack:Ae=.015,release:B=N*.2,profile:ie="spring",weight:se=1,seed:ve=K,lever:j,angularGain:X=0,enabled:G=!0}=S;i(l(P)&&n(L,0,1e12)&&n(N,1e-4,3600)&&d(H)&&d(pe)&&["camera","world","impact"].includes(de)&&["spring","shake","pulse"].includes(ie)&&n(_e,.01,240)&&n(Se,0,1e3)&&n(Ae,0,N)&&n(B,1e-6,N)&&n(se,0,16)&&Number.isSafeInteger(ve)&&n(ve,0,4294967295)&&typeof G=="boolean","invalid impulse settings"),i((ye===void 0||d(ye)&&u(ye)>1e-8)&&(Y===void 0||d(Y))&&(de!=="impact"||Y!==void 0||ye!==void 0)&&(ye===void 0||de==="impact"),"impact space needs a source or nonzero world direction"),i(n(D,0,1e6)&&(!D||Y!==void 0)&&(j===void 0||d(j))&&n(X,0,100),"invalid propagation or angular leverage");let Q=q(S.falloff);return i(!Q||Y!==void 0,"distance falloff needs a source"),{id:P,time:L,duration:N,translation:H.slice(),rotation:pe.slice(),space:de,direction:ye?y(ye):null,source:Y?.slice()??null,falloff:Q,propagationSpeed:D,frequency:_e,damping:Se,attack:Ae,release:B,profile:ie,weight:se,seed:ve,lever:j?.slice()??null,angularGain:X,enabled:G}}function b(S,k){i(c(S,["id","translation","rotation","space","frequency","octaves","persistence","weight","seed","time","fadeIn","enabled"]),"unknown handheld field");let{id:M,translation:K=[.006,.009,.002],rotation:P=[.001,.0012,8e-4],space:L="camera",frequency:N=.65,octaves:H=3,persistence:pe=.45,weight:de=1,seed:ye=k,time:Y=0,fadeIn:D=.5,enabled:_e=!0}=S;return i(l(M)&&d(K)&&d(P)&&["camera","world"].includes(L)&&n(N,.01,120)&&Number.isSafeInteger(H)&&n(H,1,5)&&n(pe,0,1)&&n(de,0,16)&&Number.isSafeInteger(ye)&&n(ye,0,4294967295)&&n(Y,0,1e12)&&n(D,0,60)&&typeof _e=="boolean","invalid handheld layer"),{id:M,translation:K.slice(),rotation:P.slice(),space:L,frequency:N,octaves:H,persistence:pe,weight:de,seed:ye,time:Y,fadeIn:D,enabled:_e}}function z(S){let k=f(S);for(let M of["direction","source","falloff","lever"])k[M]===null&&delete k[M];return k}function v(S={}){i(c(S,["impulses","handheld","seed","translationLimit","rotationLimit","maxImpulses"]),"unknown configuration field");let{impulses:k=[],handheld:M=[],seed:K=1,translationLimit:P=1,rotationLimit:L=.35,maxImpulses:N=256}=S;i(Number.isSafeInteger(K)&&n(K,0,4294967295)&&n(P,0,100)&&n(L,0,Math.PI)&&Number.isSafeInteger(N)&&n(N,1,2048)&&Array.isArray(k)&&k.length<=N&&Array.isArray(M)&&M.length<=32,"invalid limits, seed or history budget");let H=k.map((X,G)=>g(X,"impulse."+(G+1),0,x(K,X.id??"impulse."+(G+1)))),pe=M.map(X=>b(X,x(K,X.id))),de=0,ye=0,Y=k.length;i(new Set(H.map(X=>X.id)).size===H.length&&new Set(pe.map(X=>X.id)).size===pe.length,"duplicate impulse or handheld ID");let D=null,_e=null,Se=X=>X.slice().sort((G,Q)=>G.time-Q.time||(G.id<Q.id?-1:G.id>Q.id?1:0));function Ae(X=de,{pose:G=s}={}){i(n(X,0,1e12),"sample time must be nonnegative and finite"),C(G);let Q=o(),be=o(),ge=[],le=[];function Re(te,ze,me,fe,Me){for(let we=0;we<3;we++)Q[we]+=me[we],be[we]+=fe[we];ge.push({id:te,type:ze,...Me,translation:me,rotation:fe})}for(let te of D??=Se(H)){if(!te.enabled)continue;let ze=te.source?u(w(G.eye,te.source)):0,me=te.propagationSpeed?ze/te.propagationSpeed:0,fe=X-te.time-me,Me=te.weight*(te.falloff?Math.pow(Math.max(0,Math.min(1,(te.falloff.outer-ze)/(te.falloff.outer-te.falloff.inner))),te.falloff.power):1);if(!Me||fe>=te.duration)continue;if(fe<0){le.push({id:te.id,arrival:te.time+me,delay:me,distance:ze,gain:Me});continue}let we=1-F((fe-(te.duration-te.release))/te.release),Fe=te.attack?F(fe/te.attack):1,He=we*Math.exp(-fe*te.damping),it=te.profile==="spring"?Math.sin(t*te.frequency*fe)*He*Fe:te.profile==="pulse"?Fe*(1-fe/te.duration)**2*we:Fe*He,rt=G;if(te.space==="world"&&(rt=s),te.space==="impact"){let ft=te.direction??y(w(G.eye,te.source),G.back),vt=Math.abs(ft[1])>.97?[1,0,0]:[0,1,0],oe=y(_(vt,ft));rt={right:oe,up:_(ft,oe),back:ft}}let et=(ft,vt,oe)=>ft*it*Me*(te.profile==="shake"?R(fe*te.frequency*(1+vt*.13),te.seed+oe+vt*231):1),Yt=V(te.translation.map((ft,vt)=>et(ft,vt,11)),rt),Zt=V(te.rotation.map((ft,vt)=>et(ft,vt,397)),rt);if(te.lever&&te.angularGain){let ft=m(_(V(te.lever,G),Yt),te.angularGain);for(let vt=0;vt<3;vt++)Zt[vt]+=ft[vt]}Re(te.id,"impulse",Yt,Zt,{age:fe,arrival:te.time+me,delay:me,distance:ze,gain:Me,envelope:it,profile:te.profile,space:te.space})}for(let te of _e??=Se(pe)){let Me=function(we,Fe){let He=0,it=0,rt=1;for(let et=0;et<te.octaves;et++)He+=R(ze*te.frequency*(1+we*.17)*2**et,te.seed+Fe+we*307+et*647)*rt,it+=rt,rt*=te.persistence;return He/it*me};var he=Me;if(!te.enabled||X<te.time)continue;let ze=X-te.time,me=te.weight*(te.fadeIn?F(ze/te.fadeIn):1),fe=te.space==="camera"?G:s;me&&Re(te.id,"handheld",V(te.translation.map((we,Fe)=>we*Me(Fe,0)),fe),V(te.rotation.map((we,Fe)=>we*Me(Fe,991)),fe),{age:ze,gain:me,frequency:te.frequency,space:te.space})}let Pe=u(Q),Ce=u(be),Ee=Pe?Math.min(1,P/Pe):1,ke=Ce?Math.min(1,L/Ce):1;return T({time:X,translation:m(Q,Ee),rotation:m(be,ke),contributions:ge,pending:le,limits:{translationScale:Ee,rotationScale:ke},activeCount:ge.length})}function B(X){i(H.length<N,"impulse history budget reached; cancel, prune or clear history");let G=Y+1;for(i(Number.isSafeInteger(G),"serial budget exceeded");H.some(be=>be.id==="impulse."+G);)G++,i(Number.isSafeInteger(G),"serial budget exceeded");let Q=g(X,"impulse."+G,de,x(K,X?.id??"impulse."+G));return i(!H.some(be=>be.id===Q.id),"duplicate impulse ID"),H.push(Q),D=null,Y=G,Q.id}function ie(){return{format:"ink-studio/camera-impulses",version:1,time:de,compensation:ye,serial:Y,settings:{seed:K,translationLimit:P,rotationLimit:L,maxImpulses:N},impulses:H.map(z),handheld:f(pe)}}let se=ie();function ve(X){i(r(X)&&X.format==="ink-studio/camera-impulses"&&X.version===1&&n(X.time,0,1e12)&&e(X.compensation??0)&&Math.abs(X.compensation??0)<=Number.EPSILON*Math.max(1,X.time)*4&&Array.isArray(X.impulses)&&Array.isArray(X.handheld)&&Number.isSafeInteger(X.serial)&&X.serial>=0&&c(X.settings,["seed","translationLimit","rotationLimit","maxImpulses"])&&Object.entries({seed:K,translationLimit:P,rotationLimit:L,maxImpulses:N}).every(([Q,be])=>X.settings[Q]===be),"incompatible checkpoint");let G=v({...X.settings,impulses:X.impulses,handheld:X.handheld}).snapshot();return H=G.impulses.map((Q,be)=>g(Q,Q.id,0,K+be*101>>>0)),pe=G.handheld.map((Q,be)=>b(Q,K+be*139>>>0)),D=_e=null,de=X.time,ye=X.compensation??0,Y=X.serial,j}let j=Object.freeze({sample:Ae,emit:B,impulse:B,get time(){return de},advance(X,G){i(n(X,0,1e6)&&n(de+X,0,1e12),"advance needs bounded nonnegative seconds");let Q=X-ye,be=de+Q;return ye=be-de-Q,de=be,Ae(de,G)},seek(X,G){return i(n(X,0,1e12),"seek needs nonnegative seconds"),de=X,ye=0,Ae(de,G)},setLayer(X){i(r(X)&&l(X.id),"handheld edits need an ID");let G=pe.findIndex(be=>be.id===X.id),Q=b({...pe[G],...X},pe[G]?.seed??x(K,X.id));return i(G>=0||pe.length<32,"handheld layer budget reached"),_e=null,G>=0?pe[G]=Q:pe.push(Q),j},removeLayer:X=>(pe=pe.filter(G=>G.id!==X),_e=null,j),cancel:X=>(H=H.filter(G=>G.id!==X),D=null,j),clear(){return H=[],D=null,j},prune(X){return i(n(X,0,1e12),"prune needs nonnegative seconds"),D=null,H=H.filter(G=>G.time+G.duration+(G.falloff&&G.propagationSpeed?G.falloff.outer/G.propagationSpeed:G.propagationSpeed?1/0:0)>X),j},snapshot:ie,restore:ve,reset:()=>ve(se),bind(X){i(r(X),"bind needs a mutable world");let G=X.cameraImpulses;return X.cameraImpulses=j,i(X.cameraImpulses===j,"world must allow a live camera binding"),()=>{X.cameraImpulses===j&&(G===void 0?delete X.cameraImpulses:X.cameraImpulses=G)}}});return j}let A=new WeakMap;function I(S){return S===void 0||S===!1?null:typeof S?.sample=="function"?S:(i(r(S),"expected a motion definition or live impulse sampler"),A.has(S)||A.set(S,v(S)),A.get(S))}function ae(S={},k={},M){if(k.lockCamera)return null;let K=k.cameraImpulses??S.cameraImpulses??S.look?.cameraImpulses,P=I(K);if(!P)return null;let L=k.cameraImpulseTime??k.cameraTime??S.timeDomains?.read("camera").sampleTime??k.time??k.t??S.lookSnapshot?.time??P.time??0;return P.sample(L,{pose:M})}let W={recoil:{profile:"spring",space:"camera",duration:.42,frequency:17,damping:17,translation:[0,0,.12],rotation:[.045,0,.002]},crash:{profile:"spring",space:"impact",duration:1.7,frequency:5,damping:3.5,translation:[0,0,.42],rotation:[.012,.018,.018],lever:[0,.5,0],angularGain:.5,falloff:{inner:2,outer:24,power:1.5}},thunder:{profile:"shake",space:"impact",duration:3.4,frequency:1.8,damping:.7,attack:.12,translation:[0,.065,.035],rotation:[.004,.005,.003],falloff:{inner:0,outer:220,power:1.2},propagationSpeed:80}};function Z(S,k={}){i(Object.hasOwn(W,S)&&r(k),"unknown preset");let M={...f(W[S]),...f(k)};return M.space==="impact"&&M.source===void 0&&M.direction===void 0&&(M.direction=[0,0,1]),M.source===void 0&&(delete M.falloff,delete M.propagationSpeed),g(M,"preset",0,1),T(M)}return Object.freeze({create:v,prepare:I,frame:ae,preset:Z,restore:S=>v(S.settings).restore(S)})})();typeof Cn<"u"?Cn.exports=Qc:globalThis[Symbol.for("ink-studio.camera-impulses")]=Qc});function qf(e,t,o){if(!t)return null;let{ramps:s}=t;if(!s||Object.getPrototypeOf(s)!==Object.prototype)throw new TypeError("Coverage voting needs a ramps object keyed by material");let{objectIds:i,materialIds:r,materials:c}=e.renderMetadata??{};if(!i||!r||!c||!e.count)return null;if(e.count>16777214)throw new RangeError("Coverage voting needs 24-bit splat IDs");let l=new Map,d=[];for(let[m,p]of Object.entries(s)){let _=c.indexOf(m);if(!Array.isArray(p)||!p.length||p.length>o||Array.from(p).some(w=>!Number.isInteger(w)||w<0||w>=o))throw new RangeError("Each coverage ramp needs valid scene palette indices");_<0||(l.set(_,d.length+1),d.push(p))}let n=new Map,u=new Float32Array(e.count*2);for(let m=0;m<e.count;m++){let p=r[m],_=l.get(p)??0,w=i[m]+"/"+p;n.has(w)||n.set(w,n.size+1),u[m*2]=n.get(w),u[m*2+1]=_}return d.length?{memberships:u,swatches:d}:null}var Vf=e=>`#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_base,u_sampleColor,u_sampleOwner,u_voteRows,u_voteRamps;
uniform vec3 u_votePalette[${e}],u_voteOutput[${e}];
out vec4 color;
vec2 identity(vec4 sampleRow) {
  vec3 bytes = round(sampleRow.rgb*255.0);
  int row = int(dot(bytes,vec3(1,256,65536)))-1;
  if (row<0) return vec2(0);
  vec4 packedRow=texelFetch(u_voteRows,ivec2((row>>1)&511,row>>10),0);
  return (row&1)==0?packedRow.rg:packedRow.ba;
}
void main() {
  ivec2 p=ivec2(gl_FragCoord.xy);
  color=texelFetch(u_base,p,0);
  vec2 ids[4];
  vec4 samples[4];
  for(int i=0;i<4;i++){
    ivec2 tap=p*2+ivec2(i&1,i>>1);
    vec4 owner=texelFetch(u_sampleOwner,tap,0);
    ids[i]=identity(owner);
    samples[i]=texelFetch(u_sampleColor,tap,0);
    if(ids[i].x>0.0) {
      float hi=owner.a;
      samples[i].a=dot(round(vec2(hi,samples[i].a)*255.0),vec2(256,1))/65535.0;
    }
  }
  if(ids[0].x==ids[1].x&&ids[0].x==ids[2].x&&ids[0].x==ids[3].x)return;
  int winner=0, bestCount=0;
  float bestDepth=2.0;
  for(int i=0;i<4;i++){
    int count=0;
    float depth=1.0;
    for(int j=0;j<4;j++)if(ids[i].x==ids[j].x){count++;depth=min(depth,samples[j].a);}
    if(count>bestCount||count==bestCount&&(depth<bestDepth||
        depth==bestDepth&&ids[i].x<ids[winner].x)){
      winner=i;bestCount=count;bestDepth=depth;
    }
  }
  int ramp=int(ids[winner].y)-1;
  if(ramp<0)return;
  vec3 mean=vec3(0);
  for(int i=0;i<4;i++)if(ids[i].x==ids[winner].x)mean+=samples[i].rgb;
  mean/=float(bestCount);
  float best=1.0e8;
  int bestIndex=0;
  for(int i=0;i<${e};i++){
    int index=int(texelFetch(u_voteRamps,ivec2(i,ramp),0).r)-1;
    if(index<0)break;
    vec3 difference=mean-u_votePalette[index];
    float error=dot(difference*difference,vec3(.30,.55,.15));
    if(error<best){best=error;bestIndex=index;}
  }
  color.rgb=u_voteOutput[bestIndex];
}
`;function Mc(e,{samples:t,source:o,resources:s,table:i,program:r,textureUnit:c,fullscreen:l,maxSize:d,paletteSize:n}){let u=i(512,12,d),m=s.texture(),p=r(Vf(n)),_,w,y,F,T;function f(x,E,R){if(_===x.renderMetadata&&w===E&&y===x.count&&T===R)return F;if(F=qf(x,E,R),_=x.renderMetadata,w=E,y=x.count,T=R,F){if(F.swatches.length>d)throw new RangeError("Coverage ramp table exceeds the device texture limit");u.upload(F.memberships);let C=new Float32Array(n*F.swatches.length);for(let[V,q]of F.swatches.entries())C.set(q.map(g=>g+1),V*n);c(13,m),e.texImage2D(e.TEXTURE_2D,0,e.R32F,n,F.swatches.length,0,e.RED,e.FLOAT,C)}return F}return{samples:t,source:o,prepare:f,finish(x,E,R,C,V){c(8,o.textures[0]),c(10,t.textures[0]),c(11,t.textures[1]),u.bind(),c(13,m),l(p,x,E,R,{u_base:8,u_sampleColor:10,u_sampleOwner:11,u_voteRows:12,u_voteRamps:13,u_votePalette:C,u_voteOutput:V??C})}}}var Dc=_o(Pc(),1),Ic=Dc.default??globalThis[Symbol.for("ink-studio.coverage-filter")],Fn=31,Lc=`
uniform bool u_filterMatte;
uniform highp sampler2D u_filterRows;
float filterSoftness(int row){
  return texelFetch(u_filterRows,ivec2((row>>2)&511,row>>11),0)[row&3];
}
`,Xf=`#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_center,u_taps,u_centerMatte,u_tapMatte;
uniform bool u_hasMatte;
out vec4 color;
void main(){
  ivec2 pixel=ivec2(gl_FragCoord.xy);
  vec4 center=texelFetch(u_center,pixel,0);
  float softness=u_hasMatte ? texelFetch(u_centerMatte,pixel,0).r : 1.;
  vec4 result=center;
  for(int i=0;i<4;i++){
    ivec2 tap=2*pixel+ivec2(i&1,i>>1);
    float weight=u_hasMatte ? min(softness,texelFetch(u_tapMatte,tap,0).r) : 1.;
    result+=.25*weight*(texelFetch(u_taps,tap,0)-center);
  }
  color=result;
}`;function Bc({target:e,table:t,maxSize:o,program:s,textureUnit:i,fullscreen:r}){let c=e(2),l=e(),d=s(Xf),n,u,m,p,_,w,y,F;return{taps:c,filtered:l,prepare(T,f,x,E,R){if(c.resize(x*2,E*2),l.resize(x,E),R&&(m??=e(3),m.resize(x*2,E*2)),f.varied){n??=e(2),u??=e(2),n.resize(x,E),u.resize(x*2,E*2),p??=t(512,Fn,o);let{materialIds:C,materials:V}=T.renderMetadata??{};if(w!==T.renderMetadata||y!==f||F!==T.count){_?.length!==T.count&&(_=new Float32Array(T.count));for(let q=0;q<T.count;q++)_[q]=f.at(V?.[C?.[q]]);p.upload(_),w=T.renderMetadata,y=f,F=T.count}}return{centerMatte:f.varied&&n,tapMatte:f.varied&&u,sampleDepth:R&&m,bindRows:()=>p?.bind()}},finish(T,f){i(1,T),i(2,c.textures[0]),i(5,f.centerMatte?f.centerMatte.textures[0]:T),i(6,f.tapMatte?f.tapMatte.textures[0]:T),r(d,l.framebuffer,l.width,l.height,{u_center:1,u_taps:2,u_centerMatte:5,u_tapMatte:6,u_hasMatte:!!f.centerMatte})}}}function Nc(e,t,o,s,i){let r=new Uint8Array(o*s*4),c=new Float32Array(o*s);e.bindFramebuffer(e.READ_FRAMEBUFFER,t),e.readBuffer(e.COLOR_ATTACHMENT2),e.readPixels(0,0,o,s,e.RGBA,e.UNSIGNED_BYTE,r);let l=(i[1]-i[0])/16777215;for(let d=0;d<s;d++)for(let n=0;n<o;n++){let u=((s-1-d)*o+n)*4;c[d*o+n]=r[u+3]?i[0]+(r[u]+r[u+1]*256+r[u+2]*65536)*l:1/0}return c}function Li(e){return`
uniform highp sampler2D u_glassBoundary;
layout(location=${e?3:2}) out vec4 glassBack;
layout(location=${e?4:3}) out vec4 glassThrough;
void splitOpaqueSurface(vec4 color, float projectedDepth) {
  vec4 pane = texelFetch(u_glassBoundary, ivec2(gl_FragCoord.xy), 0);
  float boundary = dot(floor(pane.rgb * 255.0 + 0.5), vec3(1, 256, 65536)) / 16777215.0;
  bool behind = pane.a > 0.0 && projectedDepth > boundary + 0.0000001;
  glassBack = behind ? color : vec4(0);
  glassThrough = vec4(vec3(behind ? 1.0 : 0.0), 1.0);
}`}function Oc(e,t,o,s){let i,r,c,l,d;function n(){i&&t.free(i),i=r=void 0,c=l=void 0}function u(m,p){let _=c*3,w=Math.floor(p.length/_);if(w&&e.texSubImage2D(e.TEXTURE_2D,0,0,m,c,w,e.RGB,e.FLOAT,p),w*_<p.length){let y=(p.length-w*_)/3;e.texSubImage2D(e.TEXTURE_2D,0,0,m+w,y,1,e.RGB,e.FLOAT,p,w*_)}}return function(p,_){if(!p){n();return}if(!_)return;let{count:w,degree:y,dc:F,sh:T,up:f}=p;if(r!==p){let x=(y+1)**2-1;if(!Number.isInteger(y)||y<0||y>4||!Number.isInteger(w)||w<1||!(F instanceof Float32Array)||F.length!==w*3||!(T instanceof Float32Array)||T.length!==w*x*3||!["y","z"].includes(f))throw new TypeError("Invalid live Gaussian harmonic rows");let E=Math.min(s,Math.max(1024,Math.ceil(w*(x+1)/(s-1)))),R=Math.ceil(w/E),C=R+Math.ceil(w*x/E);if(C>s)throw new RangeError("Gaussian harmonics exceed this device\u2019s WebGL texture size");if(e.activeTexture(e.TEXTURE0+o),i??=t.texture(),e.bindTexture(e.TEXTURE_2D,i),(E!==c||C!==l)&&(e.texImage2D(e.TEXTURE_2D,0,e.RGB32F,E,C,0,e.RGB,e.FLOAT,null),c=E,l=C),u(0,F),x&&u(R,T),e.getError()!==e.NO_ERROR)throw n(),new Error("Could not upload live Gaussian harmonics on this WebGL device");d=R*c,r=p}else e.activeTexture(e.TEXTURE0+o),e.bindTexture(e.TEXTURE_2D,i);return{u_gaussianSH:o,u_gaussianWidth:c,u_gaussianOffset:d,u_gaussianCount:w,u_gaussianZUp:f==="z"}}}var Wf=[["z","1.0"],["(3.0*z*z-1.0)*0.5","3.0*z","3.0"],["(5.0*z*z-3.0)*z*0.5","(15.0*z*z-3.0)*0.5","15.0*z","15.0"],["((35.0*z*z-30.0)*z*z+3.0)*0.125","(35.0*z*z-15.0)*z*0.5","(105.0*z*z-15.0)*0.5","105.0*z","105.0"]],Hf=[["1.0","0.0"],["x","y"],["x*x-y*y","2.0*x*y"],["x*(x*x-3.0*y*y)","y*(3.0*x*x-y*y)"],["(x*x-y*y)*(x*x-y*y)-4.0*x*x*y*y","4.0*x*y*(x*x-y*y)"]];function yo(e){if(!Number.isInteger(e)||e<0||e>4)throw new RangeError("Invalid Gaussian SH degree");let t=(e+1)**2-1,o=[];for(let s=1;s<=e;s++)for(let i=-s;i<=s;i++){let r=Math.abs(i),c=(2*s+1)/(4*Math.PI)*(r?2:1);for(let u=s-r+1;u<=s+r;u++)c/=u;let d=((r%2?-1:1)*Math.sqrt(c)).toPrecision(16),n=s*s+s+i-1;o.push(`  color += gaussianCoefficient(first + ${n}) * (${d} * (${Wf[s-1][r]}) * (${Hf[r][+(i<0)]}));`)}return`
uniform highp sampler2D u_gaussianSH;
uniform int u_gaussianWidth, u_gaussianOffset, u_gaussianCount;
uniform bool u_gaussianZUp;
vec3 gaussianCoefficient(int offset) {
  return texelFetch(u_gaussianSH, ivec2(offset % u_gaussianWidth, offset / u_gaussianWidth), 0).rgb;
}
vec3 gaussianBase(int index) {
  return vec3(0.5) + 0.28209479177387814 * gaussianCoefficient(index);
}
vec3 gaussianRgb(int index, vec3 ray) {
  vec3 color = gaussianBase(index);
${e?`  vec3 d = normalize(u_gaussianZUp ? vec3(ray.x, -ray.z, ray.y) : ray);
  float x = d.x, y = d.y, z = d.z;
  int first = u_gaussianOffset + index * ${t};
${o.join(`
`)}`:""}
  return clamp(color, 0.0, 1.0);
}
`}var Kf=new WeakMap,Yf=512,Uc=26,Gc=27;function jc(e,t){if(!t)return null;let o=Kf.get(t);if(o?.data!==e.data)throw new TypeError("Compile Gaussian part proxies for this imported world");return o}var qc=`
uniform highp sampler2D u_gaussianProxyRows;
uniform int u_gaussianProxyCount;
flat out int v_gaussianProxy;
`,Vc=`
uniform highp sampler2DArray u_gaussianProxyLayers;
uniform vec2 u_proxyGrid;
uniform vec4 u_proxyLights[8];
uniform vec2 u_proxyDepthRange;
uniform mat4 u_proxyProjection;
flat in int v_gaussianProxy;
vec3 proxyNormal(vec2 encoded) {
  vec2 oct = (encoded*255.0-1.0)/127.0-1.0;
  vec3 n = vec3(oct, 1.0-abs(oct.x)-abs(oct.y));
  if (n.z < 0.0) n.xy = (1.0-abs(n.yx))*mix(vec2(-1),vec2(1),greaterThanEqual(n.xy,vec2(0)));
  return normalize(n);
}
float proxyLighting(vec3 n, vec4 light) {
  return mix(1.0, max(0.0, dot(n, normalize(light.xyz))), light.w);
}
`,$c=`
uniform mat4 u_view, u_proj;
uniform vec3 u_eye;
uniform bool u_ortho, u_live;
uniform vec4 u_clip, u_plane;
uniform vec2 u_viewport;
uniform float u_minRadius;
`,Zf=`
vec3 proxyColor(vec3 pos, vec4 source) {
  #ifdef SH
  vec3 ray = u_ortho ? -vec3(u_view[0].z,u_view[1].z,u_view[2].z) : pos-u_eye;
  if (u_live) return gaussianRgb(int(source.x),ray);
  #endif
  return source.yzw;
}
`;function Qf(e,t,o,s){let i=t===void 0?"":`#define SH
`+yo(t),r=e?`
layout(location=0) in vec4 a_start;
layout(location=1) in vec4 a_end;
layout(location=2) in vec4 a_colorA;
layout(location=3) in vec4 a_colorB;
flat out vec4 v_line, v_widthAndZ, v_axial;
flat out vec3 v_colorA,v_colorB,v_worldA,v_worldB;
`:`
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec4 a_color;
out vec3 v_world,v_ink,v_normal;
out float v_z;
`,c=e?`
  vec3 a = a_start.xyz, b = a_end.xyz;
  vec4 av = u_view*vec4(a,1), bv = u_view*vec4(b,1);
  float da = -av.z-u_near, db = -bv.z-u_near;
  if (max(da,db) <= 0.0) { gl_Position=vec4(2,2,2,1); return; }
  float blendA = da < 0.0 ? da/(da-db) : 0.0;
  float blendB = db < 0.0 ? db/(db-da) : 0.0;
  vec4 ac = u_proj*mix(av,bv,blendA), bc = u_proj*mix(bv,av,blendB);
  vec2 ap = (ac.xy/ac.w*0.5+0.5)*u_viewport, bp = (bc.xy/bc.w*0.5+0.5)*u_viewport;
  float focal = u_proj[1][1]*u_viewport.y*0.5;
  vec2 rad = max(vec2(u_minRadius), focal*vec2(mix(a_start.w,a_end.w,blendA)/ac.w,
    mix(a_end.w,a_start.w,blendB)/bc.w));
  vec2 corner = vec2(gl_VertexID & 1,gl_VertexID >> 1);
  vec2 low = min(ap-rad.x,bp-rad.y), hi = max(ap+rad.x,bp+rad.y);
  gl_Position=vec4(mix(low,hi,corner)/u_viewport*2.0-1.0,0,1);
  v_line=vec4(ap,bp);
  v_widthAndZ=vec4(rad,ac.z/ac.w,bc.z/bc.w);
  v_axial=vec4(-mix(av,bv,blendA).z,-mix(bv,av,blendB).z,1.0/ac.w,1.0/bc.w);
  v_worldA=mix(a,b,blendA); v_worldB=mix(b,a,blendB);
  vec3 colorA=proxyColor(a,a_colorA), colorB=proxyColor(b,a_colorB);
  v_colorA=mix(colorA,colorB,blendA);v_colorB=mix(colorB,colorA,blendB);
`:`
  v_world=a_position; v_normal=a_normal; v_ink=proxyColor(a_position,a_color);
  vec4 view = u_view*vec4(a_position,1); v_z=-view.z;
  gl_Position=u_proj*view;
`,l=e?`
  vec2 axis=v_line.zw-v_line.xy, from=gl_FragCoord.xy-v_line.xy;
  float span=dot(axis,axis);
  float t=span<1e-8 ? float(v_widthAndZ.w<v_widthAndZ.z) : clamp(dot(from,axis)/span,0.0,1.0);
  if (length(from-axis*t)>mix(v_widthAndZ.x,v_widthAndZ.y,t)) discard;
  float w = t*v_axial.w/max(1e-8,mix(v_axial.z,v_axial.w,t));
  vec3 world=mix(v_worldA,v_worldB,w), ink=mix(v_colorA,v_colorB,w), normal=vec3(0,1,0);
  float z=mix(v_axial.x,v_axial.y,w);
  gl_FragDepth=mix(v_widthAndZ.z,v_widthAndZ.w,t)*0.5+0.5;
`:`
  vec3 world=v_world, ink=v_ink;
  vec3 normal=dot(v_normal,v_normal)>1e-8 ? normalize(v_normal) :
    normalize(cross(dFdx(v_world),dFdy(v_world)))*(gl_FrontFacing?1.0:-1.0);
  float z=v_z;
  gl_FragDepth=gl_FragCoord.z;
`;return[`#version 300 es
precision highp float;precision highp int;
${i}
${$c}
${r}
uniform float u_near;
${Zf}
void main(){${c}}`,`#version 300 es
precision highp float;precision highp int;
${$c}
${r.replace(/^layout.*\n/gm,"").replace(/\bout /g,"in ")}
uniform int u_pass, u_owner;
uniform vec4 u_range,u_light;
uniform vec3 u_fog;
layout(location=0) out vec4 color;
layout(location=1) out vec4 depth;
${o&&!s?"vec4 aux;":"layout(location=2) out vec4 aux;"}
${o?Li(s):""}
vec4 encode(int value) {
  return vec4(value&255,(value>>8)&255,(value>>16)&255,255)/255.0;
}
void main(){
  ${l}
  vec4 point=vec4(world,1);
  if (dot(point,u_plane)<0.0 || dot(u_view*point,u_clip)<0.0 || gl_FragDepth<0.0 || gl_FragDepth>1.0) discard;
  float linear=clamp((z-u_range.x)/(u_range.y-u_range.x),0.0,1.0);
  depth=vec4(linear,0,0,1); aux=vec4(0,0,0,1);
  if (u_pass==4) {
    normal/=dot(abs(normal),vec3(1));
    vec2 oct=normal.xy;
    if (normal.z<0.0) oct=(1.0-abs(oct.yx))*mix(vec2(-1),vec2(1),greaterThanEqual(oct,vec2(0)));
    float d=round(linear*65535.0);
    color=vec4(round((oct*0.5+0.5)*254.0)+1.0,floor(d/256.0),mod(d,256.0))/255.0;
  } else if (u_pass==1) {
    color=encode(u_owner+1); aux=encode(int(round(linear*16777215.0)));
  } else if (u_pass==2) {
    color=vec4(1);
  } else if (u_pass==3) {
    color=vec4(0);
  } else {
    ink*=mix(1.0,max(0.0,dot(normal,normalize(u_light.xyz))),u_light.w);
    float haze=u_range.z<1.0?smoothstep(u_range.z,1.0,linear)*u_range.w:0.0;
    color=vec4(mix(ink,u_fog,haze),1);
    ${o?"splitOpaqueSurface(color,gl_FragDepth);":""}
  }
}`]}function Xc(e,t,o,s){let i=o(Yf,Uc,s),r=new Map,c,l,d,n,u,m,p=[];function _(y){if(c===y){i.bind();return}for(let{vao:F,buffer:T}of p)t.free(F),t.free(T);p=y.entries.map(F=>{let T=t.allocate("VertexArray"),f=t.allocate("Buffer");e.bindVertexArray(T),e.bindBuffer(e.ARRAY_BUFFER,f),e.bufferData(e.ARRAY_BUFFER,F.vertices,e.STATIC_DRAW);let x=0;for(let[E,R]of(F.stroke?[4,4,4,4]:[3,3,4]).entries())e.enableVertexAttribArray(E),e.vertexAttribPointer(E,R,e.FLOAT,!1,F.size*4,x*4),F.stroke&&e.vertexAttribDivisor(E,1),x+=R;return{...F,vao:T,buffer:f}}),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),i.upload(y.membership),c=y,l={u_gaussianProxyRows:Uc,u_gaussianProxyLayers:Gc,u_gaussianProxyCount:y.membership.length,u_proxyLights:Float32Array.from([...y.entries.flatMap(F=>F.light),...Array(8-y.entries.length).fill([0,1,0,0]).flat()])}}function w(y,F,T){let f=F.gaussian?.u_gaussianCount&&y.live&&T===0?F.degree:void 0,x=T===0&&F.glassLayers,E=(y.stroke?8:0)+(f??-1)+(x?F.wet?32:16:0);r.has(E)||r.set(E,t.program(...Qf(y.stroke,f,x,F.wet)));let R=r.get(E),{camera:C,width:V,height:q,scale:g,range:b,fog:z,plane:v,clip:A}=F;e.useProgram(R.p),e.bindVertexArray(y.vao),R.set({...F.gaussian,u_view:C.view,u_proj:C.projection,u_eye:C.eye,u_ortho:C.ortho,u_live:y.live,u_viewport:[V,q],u_near:C.clipNear,u_minRadius:y.minPixels/Math.SQRT2*g,u_range:b,u_fog:z,u_glassBoundary:13,u_light:y.light,u_pass:T,u_owner:y.owner,u_plane:v,u_clip:A});let I=y.vertices.length/y.size;y.stroke?e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,I):e.drawArrays(e.TRIANGLES,0,I)}return{prepare(y,F){_(y);let{width:T,height:f,camera:x}=F;e.activeTexture(e.TEXTURE0+Gc),d?e.bindTexture(e.TEXTURE_2D_ARRAY,d):(d=t.allocate("Texture"),e.bindTexture(e.TEXTURE_2D_ARRAY,d),e.texParameteri(e.TEXTURE_2D_ARRAY,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D_ARRAY,e.TEXTURE_MAG_FILTER,e.NEAREST));let E=y.hasMetadata?[T,f,p.length]:[1,1,1];if((!m||E.some((R,C)=>R!==m[C]))&&(e.texImage3D(e.TEXTURE_2D_ARRAY,0,e.RGBA8,...E,0,e.RGBA,e.UNSIGNED_BYTE,null),m=E),y.hasMetadata){n??=t.allocate("Framebuffer"),u??=t.allocate("Renderbuffer"),e.bindRenderbuffer(e.RENDERBUFFER,u),e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,T,f),e.bindFramebuffer(e.FRAMEBUFFER,n),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,u),e.viewport(0,0,T,f),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL),e.depthMask(!0);for(let[R,C]of p.entries())C.role!==1&&(e.framebufferTextureLayer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,d,0,R),e.clearBufferfv(e.DEPTH,0,[1]),e.clearBufferfv(e.COLOR,0,[0,0,0,0]),w(C,F,4));e.disable(e.DEPTH_TEST)}return{...l,u_proxyDepthRange:x.depthRange,u_proxyProjection:x.projection}},draw(y,F){for(let T of p)T.role===1&&w(T,y,F)},get hasGeometry(){return p.some(y=>y.role===1)}}}var pu=_o(Hc(),1);var Zc=_o(Yc(),1),Bi=Zc.default??globalThis[Symbol.for("ink-studio.camera-lens")];var eu=_o(Jc(),1),tu=eu.default??globalThis[Symbol.for("ink-studio.camera-impulses")];var Pn=new WeakMap;function Dn(e,t,o,s){if(!Number.isSafeInteger(o)||o<1||!Number.isSafeInteger(s)||s<1)throw new RangeError("Camera capture requires positive integer dimensions");let i=Xr(e,t,o,s),r=Object.freeze(Object.fromEntries(Object.entries(Cr(i)).map(([l,d])=>[l,Object.freeze(d)]))),c=Object.freeze({pose:r,ortho:i.ortho,yaw:Math.atan2(r.back[0],r.back[2]),pitch:Math.asin(Math.max(-1,Math.min(1,r.back[1])))});return Pn.set(c,{camera:i,height:s}),c}function iu(e,t,o,s){let i=Dn(e,t,o,s),{camera:r}=Pn.get(i),{eye:c,back:l}=i.pose;return{snapshot:i,camera:{...i.pose,ortho:r.ortho,tangent:r.tangent,aspect:r.aspect,near:r.clipNear,far:r.clipFar,observer:c.map((d,n)=>d-l[n]*r.setback)}}}function Xr(e,t,o,s){if(t.cameraSnapshot!==void 0){let C=Pn.get(t.cameraSnapshot);if(!C)throw new TypeError("Use a camera snapshot from captureCamera");let{camera:V}=C,q=o/s,g=C.height/s;if(q===V.aspect&&g===1)return V;let b=V.projection.slice();return b[0]*=V.aspect/q,{...V,aspect:q,projection:b,footprint:V.footprint*g,shadowFootprint:V.shadowFootprint*g}}let i=t.cameraStaging??e.look?.cameraStaging,r=Bi.frame(e,t,o,s,{orbit:i?.orbit,impulse:tu.frame}),{dist:c,distance:l,aspect:d,radius:n,ortho:u,tangent:m,clipNear:p,clipFar:_,setback:w}=r,y=Bi.artView(r,s,e.look?.stable,t.stable),F=y===r.view?r.pose.eye:Bi.fromView(y).eye,T=c*m,f=.4,x=1/m,E=u?new Float32Array([1/(T*d),0,0,0,0,1/T,0,0,0,0,-2/(_-f),0,0,0,-(_+f)/(_-f),1]):new Float32Array([x/d,0,0,0,0,x,0,0,0,0,(_+f)/(f-_),-1,0,0,2*_*f/(f-_),0]),R=u?l:c;return{view:Float32Array.from(y),projection:E,eye:F,aspect:d,ortho:u,radius:n,distance:l,lens:r.lens,composition:t.composition??r.base.composition??[.5,.5],setback:w,tangent:u?T:m,footprint:c*2*m/s,shadowFootprint:2*T/s,clipNear:p,clipFar:_,depthRange:[R-n,R+n],...r.motion&&{cameraImpulse:r.motion}}}function Cr({eye:e,view:t}){return{eye:e.slice(),right:[t[0],t[4],t[8]],up:[t[1],t[5],t[9]],back:[t[2],t[6],t[10]]}}function au(e,t,o=!1){let s=Bi.pose(o?{...t,right:t.right.map(r=>-r)}:t),i=new Float32Array(Bi.matrix(s));if(o)for(let r of[0,4,8,12])i[r]=-i[r];return{...e,eye:s.eye,view:i}}function ru(e,t,o){let s=e.asset.data,i=e.matrix,r=e.at,c=s[t],l=s[t+1],d=s[t+2],n=Math.fround;return n(o(n(i[0]*c+i[1]*l+i[2]*d+r[0]),n(i[3]*c+i[4]*l+i[5]*d+r[1]),n(i[6]*c+i[7]*l+i[8]*d+r[2])))}function Jf(e,t){let o=e.matrix,s=e.at,{sortLo:i,sortHi:r}=e.asset,c=t[2]*o[0]+t[6]*o[3]+t[10]*o[6],l=t[2]*o[1]+t[6]*o[4]+t[10]*o[7],d=t[2]*o[2]+t[6]*o[5]+t[10]*o[8],n=t[2]*s[0]+t[6]*s[1]+t[10]*s[2]+t[14],u=r.reduce((p,_,w)=>p+Math.max(Math.abs(_),Math.abs(i[w])),0),m=1e-6*(1+Math.abs(n)+Math.abs(s[0])+Math.abs(s[1])+Math.abs(s[2])+u*e.authored.scale);return[n+Math.min(c*i[0],c*r[0])+Math.min(l*i[1],l*r[1])+Math.min(d*i[2],d*r[2])-m,n+Math.max(c*i[0],c*r[0])+Math.max(l*i[1],l*r[1])+Math.max(d*i[2],d*r[2])+m]}function ou(){let e=new Uint32Array(65536),t,o,s;return function(r,c,l,d,n,u,m=[l,l],p=[0,0]){let{count:_,data:w}=r,y=d?2:1,F=_+(d?.reduce((v,A)=>v+A.asset.count,0)??0);if(!t||t.length<F){let v=Math.max(F,Math.ceil((t?.length??0)*1.25));t=new Float32Array(v),o=new Uint16Array(v)}(!s||s.length<F*y)&&(s=new Int32Array(t.length*y));let T=c[2],f=c[6],x=c[10],E=c[14],R=(v,A,I)=>T*v+f*A+x*I+E;for(let v=0,A=0;v<_;v++,A+=16)t[v]=R(w[A],w[A+1],w[A+2]);for(let v of r.moving??[]){if(v>=_)continue;let A=v*16,I=w[A+11]%16,ae=w[A+12],W=w[A+13],Z=w[A+14],S=w[A],k=w[A+1],M=w[A+2];if(I===2||I===3){let P=(I===2?m[Math.round(w[A+11])&8192?1:0]:l)*W/Z+ae,L=(P-Math.floor(P))*Z;k+=I===2?-L:L,I===2&&(S+=p[0]*L/Math.max(W,1e-5),M+=p[1]*L/Math.max(W,1e-5))}else if(I===5){let K=l*W,P=Math.cos(K),L=Math.sin(K),N=P*S+L*M;M=-L*S+P*M,S=N}else k+=Math.sin(l*W+ae)*Z;t[v]=R(S,k,M)}let C=r.anim?.bones;if(C)for(let v of r.anim.boned??[]){if(v>=_)continue;let A=v*16,I=w[A],ae=w[A+1],W=w[A+2],Z=w[A+14],S=w[A+12]*12,k=w[A+13]*12,M=(P,L)=>C[P+L*3]*I+C[P+L*3+1]*ae+C[P+L*3+2]*W+C[P+9+L],K=P=>{let L=M(S,P);return Z>0?L+(M(k,P)-L)*Z:L};t[v]=R(K(0),K(1),K(2))}let V=_;for(let v of d??[])for(let A=0;A<v.asset.data.length;A+=16)t[V++]=ru(v,A,R);let q=1/0,g=-1/0;for(let v=0;v<F;v++){let A=t[v];A<q&&(q=A),A>g&&(g=A)}if(n&&d.length<n.length){let v=0;for(let A of n){if(A===d[v]){v++;continue}let[I,ae]=Jf(A,c);if(!(I>=q&&ae<=g))for(let W=0;W<A.asset.data.length;W+=16){let Z=ru(A,W,R);Z<q&&(q=Z),Z>g&&(g=Z)}}}for(let v of r.back??[])v<_&&(t[v]=q);if(u){let v=s.subarray(0,_);for(let A=0;A<_;A++)v[A]=A;return v.sort((A,I)=>t[A]-t[I]),u(v,t)}let b=65535/(g-q||1);e.fill(0);for(let v=0;v<F;v++)e[o[v]=(t[v]-q)*b|0]++;let z=0;for(let v=0;v<e.length;v++){let A=e[v];e[v]=z,z+=A}if(d){for(let A=0;A<_;A++){let I=e[o[A]]++*2;s[I]=A,s[I+1]=0}let v=_;for(let A of d){let I=_+A.start,ae=A.index+1;for(let W=0;W<A.asset.count;W++,v++){let Z=e[o[v]]++*2;s[Z]=I+W,s[Z+1]=ae}}}else for(let v=0;v<_;v++)s[e[o[v]]++]=v;return s.length===F*y?s:s.subarray(0,F*y)}}function ur(e){let t=new Map;function o(r){let c=e["create"+r]();if(!c)throw new Error("Could not allocate WebGL "+r);return t.set(c,()=>e["delete"+r](c)),c}function s(){let r=o("Texture");return e.bindTexture(e.TEXTURE_2D,r),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),r}function i(r,c){let l=e.createProgram();if(!l)throw new Error("Could not allocate WebGL program");let d=[];try{for(let[p,_]of[[e.VERTEX_SHADER,r],[e.FRAGMENT_SHADER,c]]){let w=e.createShader(p);if(!w)throw new Error("Could not allocate WebGL shader");if(d.push(w),e.shaderSource(w,_),e.compileShader(w),!e.getShaderParameter(w,e.COMPILE_STATUS))throw new Error("Ink Studio shader compilation failed: "+e.getShaderInfoLog(w));e.attachShader(l,w)}if(e.linkProgram(l),!e.getProgramParameter(l,e.LINK_STATUS))throw new Error("Ink Studio program linking failed: "+e.getProgramInfoLog(l));let n=Object.create(null),u=Object.create(null),m={[e.FLOAT]:"uniform1f",[e.INT]:"uniform1i",[e.SAMPLER_2D]:"uniform1i",[e.SAMPLER_3D]:"uniform1i",[e.SAMPLER_2D_ARRAY]:"uniform1i",[e.INT_SAMPLER_2D]:"uniform1i",[e.UNSIGNED_INT_SAMPLER_2D]:"uniform1i",[e.FLOAT_VEC2]:"uniform2fv",[e.FLOAT_VEC3]:"uniform3fv",[e.FLOAT_VEC4]:"uniform4fv",[e.BOOL]:"uniform1i",[e.BOOL_VEC2]:"uniform2iv",[e.BOOL_VEC3]:"uniform3iv",[e.BOOL_VEC4]:"uniform4iv",[e.INT_VEC2]:"uniform2iv",[e.INT_VEC3]:"uniform3iv",[e.INT_VEC4]:"uniform4iv",[e.UNSIGNED_INT]:"uniform1ui",[e.UNSIGNED_INT_VEC2]:"uniform2uiv",[e.UNSIGNED_INT_VEC3]:"uniform3uiv",[e.UNSIGNED_INT_VEC4]:"uniform4uiv",[e.FLOAT_MAT2]:"uniformMatrix2fv",[e.FLOAT_MAT3]:"uniformMatrix3fv",[e.FLOAT_MAT4]:"uniformMatrix4fv",[e.FLOAT_MAT2x3]:"uniformMatrix2x3fv",[e.FLOAT_MAT2x4]:"uniformMatrix2x4fv",[e.FLOAT_MAT3x2]:"uniformMatrix3x2fv",[e.FLOAT_MAT3x4]:"uniformMatrix3x4fv",[e.FLOAT_MAT4x2]:"uniformMatrix4x2fv",[e.FLOAT_MAT4x3]:"uniformMatrix4x3fv"};for(let p=0,_=e.getProgramParameter(l,e.ACTIVE_UNIFORMS);p<_;p++){let w=e.getActiveUniform(l,p),y=w.name.replace(/\[0\]$/,""),F=n[y]=e.getUniformLocation(l,y),T=m[w.type];w.size>1&&["uniform1f","uniform1i","uniform1ui"].includes(T)&&(T+="v"),T?.startsWith("uniformMatrix")?u[y]=f=>e[T](F,!1,f):T&&(u[y]=f=>e[T](F,f))}return t.set(l,()=>e.deleteProgram(l)),{p:l,u:n,set(p){for(let _ of Object.keys(p))u[_]?.(p[_])}}}catch(n){throw e.deleteProgram(l),n}finally{for(let n of d)e.deleteShader(n)}}return{allocate:o,texture:s,program:i,free(r){t.get(r)?.(),t.delete(r)},dispose(){for(let r of[...t.values()].reverse())r();t.clear()}}}function go(e,t){let o=(r,c)=>{e.activeTexture(e.TEXTURE0+r),e.bindTexture(e.TEXTURE_2D,c)};function s(r=1,{integer:c=!1,floating:l=!1,depth:d=!1}={}){if(l&&!e.getExtension("EXT_color_buffer_float"))throw new Error("Spatial dither needs WebGL floating-point render attachments");let n=t.allocate("Framebuffer"),u=Array.from({length:r},()=>t.texture()),m=d?t.allocate("Renderbuffer"):null;e.bindFramebuffer(e.FRAMEBUFFER,n);let p=u.map((y,F)=>{let T=e.COLOR_ATTACHMENT0+F;return e.framebufferTexture2D(e.FRAMEBUFFER,T,e.TEXTURE_2D,y,0),T});e.drawBuffers(p),m&&(e.bindRenderbuffer(e.RENDERBUFFER,m),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,m)),e.bindFramebuffer(e.FRAMEBUFFER,null);let _=0,w=0;return{framebuffer:n,textures:u,get width(){return _},get height(){return w},dispose(){t.free(n);for(let y of u)t.free(y);m&&t.free(m)},ensureDepth(){m||(m=t.allocate("Renderbuffer"),e.bindRenderbuffer(e.RENDERBUFFER,m),_&&w&&e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,_,w),e.bindFramebuffer(e.FRAMEBUFFER,n),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,m))},resize(y,F){if(!(_===y&&w===F)){for(let T of u)o(0,T),c?e.texImage2D(e.TEXTURE_2D,0,e.RGBA32I,y,F,0,e.RGBA_INTEGER,e.INT,null):l?e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,y,F,0,e.RGBA,e.FLOAT,null):e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,y,F,0,e.RGBA,e.UNSIGNED_BYTE,null);if(m&&(e.bindRenderbuffer(e.RENDERBUFFER,m),e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,y,F)),e.bindFramebuffer(e.FRAMEBUFFER,n),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw new Error("Ink Studio could not build a complete WebGL render target");_=y,w=F}}}}function i(r,c,l){let d=t.texture(),n=r*4,u=new Float32Array(n),m=0;function p(_,w=_.length,y){let F=Math.max(1,Math.ceil(w/n));if(F>l)throw new RangeError("Ink Studio data exceeds the WebGL texture size limit");o(c,d),F!==m&&(e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,r,F,0,e.RGBA,e.FLOAT,null),m=F,y=void 0);let T=Math.floor(w/n);if(y!==void 0){for(let f of y){let x=f*n;f<T?e.texSubImage2D(e.TEXTURE_2D,0,0,f,r,1,e.RGBA,e.FLOAT,_,x):(u.fill(0),u.set(_.subarray(x,w)),e.texSubImage2D(e.TEXTURE_2D,0,0,f,r,1,e.RGBA,e.FLOAT,u))}return}T&&e.texSubImage2D(e.TEXTURE_2D,0,0,0,r,T,e.RGBA,e.FLOAT,_),T<F&&(u.fill(0),u.set(_.subarray(T*n,w)),e.texSubImage2D(e.TEXTURE_2D,0,0,T,r,1,e.RGBA,e.FLOAT,u))}return{bind:(_=c)=>o(_,d),upload:p}}return{target:s,table:i,textureUnit:o}}var ep=new WeakMap;var tp=e=>Number.isFinite(e)&&e>=0&&e<=1;function bo(e,t){if(!t)return null;let o=ep.get(t);if(!o||o.harmonics!==e.gaussianHarmonics||o.harmonics.count!==e.count)throw new TypeError("Compile Gaussian materials for this imported world");return o.assigned?o:null}function rp(e={}){let{direction:t=[-.65,.85,.55],strength:o=1}=e,s=t?.length===3&&Math.hypot(...t);if(!Number.isFinite(s)||s<1e-6||!tp(o))throw new RangeError("Gaussian material light needs a finite direction and a strength from 0 to 1");return[...Array.from(t,i=>i/s),o]}var nu=`
uniform vec3 u_gaussianMaterialRamp[48];
uniform vec4 u_gaussianMaterialSettings[6];
`,su=`
${nu}
uniform highp sampler2D u_gaussianMaterialRows;
uniform vec4 u_gaussianMaterialLight, u_gaussianMaterialResponse[6];
flat out int v_gaussianMaterial;

vec3 shadeGaussianMaterial(int index, vec3 ray, vec3 source) {
  vec4 row = texelFetch(u_gaussianMaterialRows, ivec2(index % 512, index / 512), 0);
  v_gaussianMaterial = int(row.w);
  if (v_gaussianMaterial == 0) return source;
  int slot = v_gaussianMaterial - 1;
  vec4 settings = u_gaussianMaterialSettings[slot], response = u_gaussianMaterialResponse[slot];
  float normalLength = length(row.xyz);
  float confidence = clamp(normalLength, 0.0, 1.0);
  vec3 normal = row.xyz / max(normalLength, 0.0001);
  vec3 light = u_gaussianMaterialLight.xyz;
  vec3 halfVector = light - ray / max(length(ray), 0.0001);
  float diffuse = abs(dot(normal, light));
  float sheen = pow(abs(dot(normal, halfVector / max(length(halfVector), 0.0001))), mix(48.0, 4.0, response.w));
  vec3 dc = clamp(gaussianBase(index), 0.0, 1.0);
  float detail = dot(dc, vec3(.30, .55, .15)) - .5;
  float tone = clamp(response.x + (response.y * diffuse + response.z * sheen) *
    u_gaussianMaterialLight.w * confidence + settings.z * detail, 0.0, 1.0);
  float stepAt = tone * (settings.x - 1.0);
  int lo = int(stepAt), hi = min(lo + 1, int(settings.x) - 1), start = slot * 8;
  vec3 base = mix(u_gaussianMaterialRamp[start + lo], u_gaussianMaterialRamp[start + hi], fract(stepAt));
  return clamp(base + settings.y * (source - dc), 0.0, 1.0);
}
`,cu=`
flat in int v_gaussianMaterial;
uniform bool u_gaussianMaterialPass;
`,uu=`
  if (u_gaussianMaterialPass) {
    vec3 slot = vec3(v_gaussianMaterial);
    o = vec4(vec3(equal(slot, vec3(1, 2, 3))) * a, a);
    od = vec4(vec3(equal(slot, vec3(4, 5, 6))) * a, a);
    return;
  }
`,ip=`#version 300 es
precision highp float;
uniform sampler2D u_resolved, u_shaded, u_materialLow, u_materialHigh;
uniform int u_gaussianMaterialLayers;
${nu}
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = texelFetch(u_resolved, p, 0);
  vec4 low = texelFetch(u_materialLow, p, 0);
  vec3 high = texelFetch(u_materialHigh, p, 0).rgb;
  float weight = 0.0;
  int slot = 0;
  for (int i = 0; i < u_gaussianMaterialLayers; i++) {
    float visible = i < 3 ? low[i] : high[i-3];
    if (visible > weight) { weight = visible; slot = i; }
  }
  if (weight < 0.035 || weight < 0.45 * low.a) return;
  vec3 source = texelFetch(u_shaded, p, 0).rgb;
  int start = slot * 8, count = int(u_gaussianMaterialSettings[slot].x);
  float best = 1e9;
  for (int i = 0; i < count; i++) {
    vec3 swatch = u_gaussianMaterialRamp[start + i];
    vec3 d = swatch - source;
    float error = dot(d * d, vec3(.30, .55, .15));
    if (error < best) { best = error; o.rgb = swatch; }
  }
}
`;function lu(e,t,o){e.activeTexture(e.TEXTURE0+11);let s=t(512,11,o),i;return{bind(r,c){return r.rows!==i?(s.upload(r.rows),i=r.rows):s.bind(),{u_gaussianMaterialRows:11,u_gaussianMaterialLight:rp(c),u_gaussianMaterialRamp:r.ramp,u_gaussianMaterialSettings:r.settings,u_gaussianMaterialResponse:r.response}},rebind:s.bind}}function fu({target:e,program:t,textureUnit:o,fullscreen:s}){let i=e(),r=e(2),c=t(ip);return{source:i,coverage:r,resize(l,d){i.resize(l,d),r.resize(l,d)},finish(l,d,n,u,m){for(let[p,_]of[i.textures[0],d,...r.textures].entries())o(p+12,_);s(c,n,u,m,{u_resolved:12,u_shaded:13,u_materialLow:14,u_materialHigh:15,u_gaussianMaterialLayers:l.layers,u_gaussianMaterialRamp:l.ramp,u_gaussianMaterialSettings:l.settings})}}}var Md=pu.default??globalThis[Symbol.for("ink-studio.png-bytes")],In=Symbol("Gaussian turntable coverage"),Ln=Symbol("Gaussian turntable normal owners");function ap(e,t){let{angles:o,width:s,height:i,columns:r,fps:c,cutoff:l,pivot:d,normals:n}=t,u=(m,p,_)=>Number.isInteger(m)&&m>=p&&m<=_;if(!e?.gaussianHarmonics)throw new TypeError("A turntable needs a live imported Gaussian cloud");if(!Array.isArray(o)||!o.length||o.length>64||![...o].every(Number.isFinite)||!u(s,1,512)||!u(i,1,512)||!u(r,1,64)||!Number.isFinite(c)||c<1||c>60||!Number.isFinite(l)||l<=0||l>1||!Array.isArray(d)||d.length!==3||![...d].every(Number.isFinite)||typeof n!="boolean")throw new RangeError("A turntable needs 1\u201364 angles, valid tile dimensions, FPS, coverage cutoff and an XYZ pivot")}var du=e=>[e>>16,e>>8&255,e&255];function op(e,t){let[o,s,i]=du(t),r=0,c=1/0;for(let[l,[d,n,u]]of e.entries()){let m=.3*(o-d)**2+.55*(s-n)**2+.15*(i-u)**2;m<c&&(r=l,c=m)}return r}function np(e,t,o,s,{right:i,up:r,back:c}){let l=s*3;if(l<0||!o||l+2>=o.length)return!1;let d=o[l],n=o[l+1],u=o[l+2],m=Math.hypot(d,n,u);if(!m)return!1;let p=y=>y[0]*d+y[1]*n+y[2]*u,_=p(c),w=(_<0?-.5:.5)/m;return e[t]=Math.round(255*(.5+w*p(i))),e[t+1]=Math.round(255*(.5+w*p(r))),e[t+2]=Math.round(255*(.5+w*_)),e[t+3]=255,!0}function vu(e,t,o,{angles:s=Array.from({length:8},(p,_)=>_*45),width:i=128,height:r=i,columns:c=4,fps:l=8,cutoff:d=.25,pivot:n=o?.cam?.target??[0,0,0],frame:u={},normals:m=!1}={}){ap(o,{angles:s,width:i,height:r,columns:c,fps:l,cutoff:d,pivot:n,normals:m});let p=Math.min(c,s.length),_=p*i,w=Math.ceil(s.length/p)*r;if(_*w>16e6)throw new RangeError("Turntable sheet exceeds the pixel budget");let y=u.splatPaint??o.splatPaint,F=bo(o,u.gaussianMaterials??o.gaussianMaterials),T=[...new Set([...o.pal,...y?.ramp??[],...F?.palettes.flat()??[]])];if(!T.length||T.length>255)throw new RangeError("A transparent turntable needs 1\u2013255 opaque palette entries");let f=T.map(du),x=f.length,E=new Map(T.map((ae,W)=>[ae,W])),R=new Uint8Array(_*w).fill(x),C=new Uint8Array(i*r*4),V=new Uint8Array(C.length),q=m?new Uint8Array(_*w*4):null,g=m?new Uint8Array(C.length):null,b=o.gaussianHarmonics.normals,z=[],v={x:i/2,y:r/2},A={...o.cam,...u.camera,pose:void 0,target:[...n],composition:[.5,.5],ortho:!0},I=ur(e);try{let W=function(Z,S){e.bindFramebuffer(e.READ_FRAMEBUFFER,Z),e.readPixels(0,0,i,r,e.RGBA,e.UNSIGNED_BYTE,S)},ae=go(e,I).target();ae.resize(i,r);for(let[Z,S]of s.entries()){let k=S%360*Math.PI/180,M=Dn(o,{camera:{...A,yaw:k},cameraStaging:!1,cameraImpulses:!1,stable:!1},i,r),K=!1,P=!1;if(t(o,{...u,width:i,height:r,target:ae,cameraSnapshot:M,gaussianColor:"palette",colored:!1,damp:!1,dither:u.dither??0,changedRows:[],splatPaint:y?{...y,preview:!1}:!1,[In]:ye=>{W(ye,V),K=!0},...m&&{[Ln]:{cutoff:Math.max(.035,d*.3),read:ye=>{W(ye,g),P=!0}}}}),!K||m&&!P)throw new Error("Turntable did not receive its Gaussian capture passes");if(W(ae.framebuffer,C),e.getError()!==e.NO_ERROR)throw new Error("Could not read the rendered turntable frame");let L=Z%p*i,N=Math.floor(Z/p)*r,H=0,pe=0,de=!1;for(let ye=0;ye<r;ye++)for(let Y=0;Y<i;Y++){let D=((r-1-ye)*i+Y)*4;if(V[D+3]<Math.ceil(d*255))continue;let _e=C[D]<<16|C[D+1]<<8|C[D+2];E.has(_e)||E.set(_e,op(f,_e));let Se=(N+ye)*_+L+Y;if(R[Se]=E.get(_e),q&&g[D+3]){let Ae=(g[D]|g[D+1]<<8|g[D+2]<<16)-1;np(q,Se*4,b,Ae,M.pose)&&pe++}H++,de||=Y===0||ye===0||Y===i-1||ye===r-1}z.push({angle:S,rect:{x:L,y:N,width:i,height:r},pivot:{...v},duration:1/l,pixels:H,touchesBorder:de,...m&&{normalPixels:pe}})}}finally{e.bindFramebuffer(e.FRAMEBUFFER,null),I.dispose()}return{width:_,height:w,indices:R,...q&&{normal:q},metadata:{version:1,width:_,height:w,fps:l,cutoff:d,transparent:x,palette:[...f,[0,0,0]],projection:"orthographic",worldPivot:[...n],camera:{pitchDegrees:(A.pitch??0)*180/Math.PI,distance:A.dist},frames:z,...m&&{normalSpace:"view",encodings:{normal:"XYZ mapped from [-1,1] to RGB, alpha marks a normal"}}}}}function hu(e,t){if(!t||!e.gaussianHarmonics)return null;let{mask:o,protect:s=!1,preview:i=!1,ramp:r}=t;if(!o||o.count!==e.gaussianHarmonics.count||!(Array.isArray(o.indices)||o.indices instanceof Uint32Array)||typeof s!="boolean"||typeof i!="boolean"||r!=null&&(!Array.isArray(r)||!r.length||r.length>64||!r.every(c=>Number.isInteger(c)&&c>=0&&c<=16777215)))throw new TypeError("Splat paint needs a mask for the imported cloud and an optional RGB ramp");return o.indices.length&&(s||i||r)?{mask:o,protect:s,preview:i,ramp:r}:null}var sp=`#version 300 es
precision highp float;
uniform sampler2D u_resolved, u_sceneColor, u_coverage, u_marked;
uniform vec3 u_ramp[64];
uniform int u_rampCount;
uniform bool u_protect, u_preview;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 base = texelFetch(u_resolved, p, 0);
  float marked = texelFetch(u_marked, p, 0).r, coverage = texelFetch(u_coverage, p, 0).a;
  if (marked >= 0.035 && marked >= 0.45 * coverage) {
    if (u_rampCount > 0) {
      vec3 source = texelFetch(u_sceneColor, p, 0).rgb;
      float best = 1e9;
      for (int i = 0; i < u_rampCount; i++) {
        vec3 d = u_ramp[i] - source;
        float error = dot(d*d, vec3(0.30, 0.55, 0.15));
        if (error < best) { best = error; base.rgb = u_ramp[i]; }
      }
    }
    if (u_protect) base.a = 0.5;
    if (u_preview) base.rgb = mix(base.rgb, vec3(.16, .92, .83), .53);
  }
  o = base;
}
`;function mu({table:e,target:t,maxSize:o,program:s,textureUnit:i,fullscreen:r}){let c=t(),l=t(2),d=s(sp),n=12,u=e(512,n,o),m;return{source:c,mask:l,resize(p,_){c.resize(p,_),l.resize(p,_)},bind(p){if(p!==m){let _=new Float32Array(p.count);for(let w of p.indices){if(!Number.isInteger(w)||w<0||w>=p.count)throw new RangeError("Invalid painted splat index");_[w]=1}u.upload(_),m=p}else u.bind();return n},finish(p,_,w,y,F){for(let[f,x]of[c.textures[0],_,...l.textures].entries())i(f+12,x);let T=new Float32Array(192);p.ramp?.forEach((f,x)=>T.set([f>>16,f>>8&255,f&255].map(E=>E/255),x*3)),r(d,w,y,F,{u_resolved:12,u_sceneColor:13,u_coverage:14,u_marked:15,u_rampCount:p.ramp?.length??0,u_ramp:T,u_protect:p.protect,u_preview:p.preview})}}}var Bn=(e,t,o)=>Number.isSafeInteger(e)&&e>=t&&e<=o;function _u(e,t={}){if(e===void 0||e==="center")return null;if(e!=="surface"||!t||typeof t!="object"||Array.isArray(t)||Object.keys(t).some(c=>!["region","layers","maxSplats","maxPixels"].includes(c)))throw new TypeError("Splat order needs center or surface with optional surface-order settings");let{region:o=[0,0,1,1],layers:s=4,maxSplats:i=8192,maxPixels:r=98304}=t;if(!Array.isArray(o)||o.length!==4||!Array.from(o).every(c=>Number.isFinite(c)&&c>=0&&c<=1)||!o[2]||!o[3]||o[0]+o[2]>1||o[1]+o[3]>1||!Bn(s,2,8)||!Bn(i,2,32767)||!Bn(r,1,524288))throw new RangeError("Surface order needs a normalized region, 2\u20138 layers and bounded splat and pixel budgets");return{region:o,layers:s,maxSplats:i,maxPixels:r}}function xu(e,t,o){let[s,i,r,c]=e,l=Math.floor(t*s),d=Math.ceil(t*(s+r)),n=o-Math.ceil(o*(i+c)),u=o-Math.floor(o*i);return[l,n,d-l,u-n]}function cp(e){let t=e.renderMetadata?.normals,o=e.surfaceData,s=e.pix,i=e.gaussianHarmonics?.normals,r=new Float32Array(e.count*4),c=!1;for(let l=0;l<e.count;l++){let d=l*3,n=l*8,u=l*4,m=t?.[d]??0,p=t?.[d+1]??0,_=t?.[d+2]??0;s?.[n]&&(m=s[n+3],p=s[n+4],_=s[n+5]),!m&&!p&&!_&&o?.[n]&&(m=o[n+1],p=o[n+2],_=o[n+3]),!(!m&&!p&&!_&&i&&(m=i[d]/127,p=i[d+1]/127,_=i[d+2]/127,m*m+p*p+_*_<.0225))&&Number.isFinite(m)&&Number.isFinite(p)&&Number.isFinite(_)&&(m||p||_)&&(r[u]=m,r[u+1]=p,r[u+2]=_,c=!0)}if(!c)return null;for(let l of e.back??[])l>=0&&l<e.count&&(r[l*4+3]=1);return r}var yu=`
uniform bool u_surfacePeel;
uniform highp sampler2D u_surfaceRows;
flat out vec4 v_surfacePlane;
flat out vec2 v_surfaceAxial;
flat out uint v_surfaceRank;
void surfaceOrderVertex(int row, mat3 frame, mat3 view, mat3 cov, vec3 center, bool behind) {
  vec4 data = texelFetch(u_surfaceRows, ivec2(row % 512, row / 512), 0);
  vec3 normal = data.xyz;
  v_surfacePlane = vec4(0.0);
  if (dot(normal, normal) > 0.0 && abs(determinant(frame)) > 1e-8) {
    normal = normalize(view * transpose(inverse(frame)) * normal);
    v_surfacePlane = vec4(normal, dot(normal, center));
  }
  v_surfaceAxial = vec2(-center.z, 3.0 * sqrt(max(0.0, cov[0][0] + cov[1][1] + cov[2][2])));
  // Signed only here. A background row is behind every ordinary sample.
  if (data.w > 0.0 || behind) v_surfaceAxial.x = -v_surfaceAxial.x;
  v_surfaceRank = uint(gl_InstanceID) + 1u;
}`,gu=`
uvec2 surfaceKey(vec4 rgba) {
  uvec4 bytes = uvec4(round(rgba * 255.0));
  return uvec2(bytes.r | (bytes.g << 8), bytes.b | (bytes.a << 8));
}
`,bu=`
uniform bool u_surfacePeel, u_surfaceNext, u_surfaceOrtho;
uniform highp sampler2D u_surfacePrevious;
uniform vec4 u_surfaceProjection;
uniform vec3 u_surfaceLens;
uniform vec2 u_surfaceRange;
uniform float u_surfaceNear;
flat in vec4 v_surfacePlane;
flat in vec2 v_surfaceAxial;
flat in uint v_surfaceRank;
${gu}
vec4 surfacePeelKey(out float axial) {
  axial = abs(v_surfaceAxial.x);
  vec2 pixel = (gl_FragCoord.xy - u_surfaceLens.xy * 0.5) / u_surfaceLens.z;
  vec3 origin = u_surfaceOrtho ? vec3(pixel, 0.0) : vec3(0.0);
  vec3 ray = u_surfaceOrtho ? vec3(0.0, 0.0, -1.0) : vec3(pixel, -1.0);
  float facing = dot(v_surfacePlane.xyz, ray);
  if (abs(facing) >= .025 * length(ray)) {
    float hit = (v_surfacePlane.w - dot(v_surfacePlane.xyz, origin)) / facing;
    if (hit > 0.0) axial += clamp(hit - axial, -v_surfaceAxial.y, v_surfaceAxial.y);
  }
  axial = max(u_surfaceNear, axial);
  float projected = dot(u_surfaceProjection.xy, vec2(axial, 1.0))
    / dot(u_surfaceProjection.zw, vec2(axial, 1.0));
  uint depth = v_surfaceAxial.x < 0.0 ? 65535u : uint(round(clamp(projected * .5 + .5, 0.0, 1.0) * 65534.0));
  uint rank = v_surfaceRank;
  if (u_surfaceNext) {
    uvec2 previous = surfaceKey(texelFetch(u_surfacePrevious, ivec2(gl_FragCoord.xy), 0));
    uint last = previous.y & 32767u;
    if (last == 0u || depth < previous.x || (depth == previous.x && rank >= last)) discard;
    // An inversion relative to the submitted order is the only reason to
    // replace center compositing. Store the marker in the spare rank bit.
    if (rank > last) rank |= 32768u;
  }
  gl_FragDepth = float(depth) / 65535.0;
  return vec4(depth & 255u, depth >> 8, rank & 255u, rank >> 8) / 255.0;
}
`,up=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_color, u_depth, u_key;
layout(location=0) out vec4 color;
layout(location=1) out vec4 depth;
layout(location=2) out vec4 inverted;
${gu}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec2 key = surfaceKey(texelFetch(u_key, p, 0));
  color = texelFetch(u_color, p, 0);
  depth = texelFetch(u_depth, p, 0);
  inverted = (key.y & 32768u) != 0u ? vec4(1.0) : vec4(0.0);
}`,lp=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_centerColor, u_centerDepth, u_orderedColor, u_orderedDepth, u_inverted, u_overflow;
uniform bool u_checkOverflow;
uniform ivec4 u_region;
uniform vec4 u_background;
layout(location=0) out vec4 color;
layout(location=1) out vec4 depth;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool inBounds = all(greaterThanEqual(p, u_region.xy)) && all(lessThan(p, u_region.xy + u_region.zw));
  if (inBounds && texelFetch(u_inverted, p, 0).r > .5 &&
      (!u_checkOverflow || texelFetch(u_overflow, p, 0).a == 0.0 && texelFetch(u_overflow, p, 0).b == 0.0)) {
    vec4 c = texelFetch(u_orderedColor, p, 0), d = texelFetch(u_orderedDepth, p, 0);
    color = c + vec4(u_background.rgb, u_background.a) * (1.0 - c.a);
    depth = d + vec4(1.0, 0.0, 0.0, 1.0) * (1.0 - d.a);
  } else {
    color = texelFetch(u_centerColor, p, 0);
    depth = texelFetch(u_centerDepth, p, 0);
  }
}
`;function wu(e,{target:t,table:o,maxSize:s,textureUnit:i,fullscreen:r,program:c}){e.activeTexture(e.TEXTURE0+3);let l=o(512,3,s),d=[],n,u,m,p,_,w,y=[0,0,0,0];function F(f){let x=[f.renderMetadata?.normals,f.pix,f.surfaceData,f.gaussianHarmonics?.normals,f.back,f.count];if(!n||x.some((E,R)=>E!==n[R])){let E=cp(f);E&&l.upload(E),u=!!E,n=x}return u&&(l.bind(),l.bind(15)),u}function T(f,x,E,R,C,V){let{width:q,height:g}=f,{rect:b,layers:z,overflow:v}=R;e.activeTexture(e.TEXTURE0+1),m??=[t(3,{depth:!0}),t(3,{depth:!0})],p??=t(3),_??=c(up),w??=c(lp);let A=d[C]??=t(2);for(let Z of[...m,p,A])Z.resize(q,g);let I=x.projection,ae={u_surfacePeel:!0,u_surfaceRows:3,u_surfacePrevious:15,u_surfaceProjection:[-I[10],I[14],-I[11],I[15]],u_surfaceLens:[q,g,g/(2*x.tangent)],u_surfaceRange:x.depthRange,u_surfaceOrtho:x.ortho,u_surfaceNear:x.clipNear},W;try{e.enable(e.SCISSOR_TEST),e.scissor(...b),e.bindFramebuffer(e.FRAMEBUFFER,p.framebuffer);for(let Z=0;Z<3;Z++)e.clearBufferfv(e.COLOR,Z,y);for(let Z=0,S=z+Number(v);Z<S;Z++){let k=m[Z&1],M=m[Z&1^1];e.bindFramebuffer(e.FRAMEBUFFER,k.framebuffer),e.viewport(0,0,q,g),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthMask(!0),e.depthFunc(e.LEQUAL);for(let K=0;K<3;K++)e.clearBufferfv(e.COLOR,K,y);if(e.clearBufferfv(e.DEPTH,0,[1]),l.bind(),i(15,M.textures[2]),V({...ae,u_surfaceNext:Z>0}),W=k.textures[2],Z===z)break;e.disable(e.DEPTH_TEST),e.enable(e.BLEND),e.blendFunc(e.ONE_MINUS_DST_ALPHA,e.ONE),i(1,k.textures[0]),i(2,k.textures[1]),i(5,k.textures[2]),r(_,p.framebuffer,q,g,{u_color:1,u_depth:2,u_key:5})}}finally{e.disable(e.SCISSOR_TEST),e.disable(e.DEPTH_TEST),e.disable(e.BLEND),e.depthMask(!0)}return i(1,f.textures[0]),i(2,f.textures[1]),i(5,p.textures[0]),i(6,p.textures[1]),i(9,p.textures[2]),i(13,W),r(w,A.framebuffer,q,g,{u_centerColor:1,u_centerDepth:2,u_orderedColor:5,u_orderedDepth:6,u_inverted:9,u_overflow:13,u_checkOverflow:v,u_region:b,u_background:E}),A}return{prepare:F,draw:T,uniforms:{u_surfaceRows:3,u_surfacePrevious:15}}}function ku(e=8192){let t,o,s=0,i=[],r=[];return function(l,d,n,u){if(!(l instanceof Float32Array)||!Number.isSafeInteger(d)||d<0||d>l.length||!Array.isArray(n)||n.some(F=>!(F instanceof Float32Array)))throw new TypeError("Attached data needs bounded Float32 tables");let m=Math.ceil(d/e),p=n.map(F=>{let T=m;return m+=Math.ceil(F.length/e),T}),_=!t||t.length!==m*e||s!==d;_&&(t=new Float32Array(m*e));let w=new Set(u??[]),y=_||u===void 0||o!==l;if(y)t.set(l.subarray(0,d));else for(let F of u){let T=F*e,f=Math.min(d,T+e);T<f&&t.set(l.subarray(T,f),T)}return n.forEach((F,T)=>{if(_||i[T]!==F||r[T]!==p[T]){let f=p[T]*e;if(t.fill(0,f,f+Math.ceil(F.length/e)*e),t.set(F,f),!y)for(let x=p[T];x<p[T]+Math.ceil(F.length/e);x++)w.add(x)}}),o=l,s=d,i=n.slice(),r=p,{data:t,offsets:p,changedRows:y?void 0:[...w]}}}var fp=new Float32Array(8);function Tu(e,t,o){let s=t.map(d=>d.brushwork?null:d.screenPrint?e.print.pack(d.screenPrint):e.maps(d).data),i=[...new Set(s.filter(Boolean))],r=new Float32Array(t.length*9*4),c=o+Math.ceil(r.length/8192),l=new Map;for(let d of i)l.set(d,c),c+=Math.ceil(d.length/8192);return t.forEach((d,n)=>{let u=d.brushwork,m=s[n],p=u||d.screenPrint?fp:e.maps(d).levels[2].means;r.set([u?0:l.get(m)*(d.screenPrint?-1:1),u?d.seed&16777215:d.screenPrint?+(d.screenPrint.space==="screen"):d.resolution,u?d.seed>>>24:["plane","cylinder","sphere","triplanar"].indexOf(d.projection),["normal","luminance","hybrid"].indexOf(d.tone),d.scale,d.density,d.contrast,d.bias,...d.ink,d.strength,...d.paper,d.ambient,...d.origin,d.radius,...d.along,u?u.groupScale:d.lodBias,...u?[u.width,...u.detailPixels]:d.across,u?.groupContrast??0,...p],n*36)}),{params:r,fields:i}}function Ru(e){let t=ku(),o,s,i,r,c,l,d;return(n,u,m,p)=>{let _=e.validate(n),w=n.splatFootprints?.frames;if(_!==o||w!==s||n.count!==i){if(e.validate(n),!w)throw new Error("Engraving needs retained surface axes");if(!(o&&_.indices===o.indices&&_.anchors===o.anchors&&_.restFrames===o.restFrames&&s===w&&i===n.count)){r=new Float32Array(n.count*16);for(let T=0;T<_.indices.length;T++){let f=_.indices[T];if(!f)continue;let x=T*6,E=T*16,R=T*3;r.set([f,..._.anchors.subarray(R,R+3),..._.restFrames.subarray(x,x+3),w[x],..._.restFrames.subarray(x+3,x+6),w[x+1],w[x+2],w[x+3],w[x+4],w[x+5]],E)}}(d!==_.styles||i!==n.count)&&({params:c,fields:l}=Tu(e,_.styles,2*Math.ceil(n.count*16/8192))),o=_,s=w,i=n.count,d=_.styles}let y=t(u,n.count*16,[r,c,...l],m);return{...y,uniforms:{u_engravingRows:y.offsets[0],u_engravingSettings:y.offsets[1],u_engravingLight:e.light(p)}}}}function Au(e,t,o,s){let i=t(2048,14,o),r=new WeakMap,c=[];return(l,d,n,u)=>{if(n.engraving===!1)return;let m=[],p=new Map,_=u?e.validate(l):null;function w(x){if(!x)return 0;let E=JSON.stringify(x),R=p.get(E);if(R)return R;if(m.length>=64)throw new RangeError("Surface engraving exceeds 64 styles per view");return m.push(x),R=m.length,p.set(E,R),R}let y=new Set;if(_)for(let x=0;x<l.count;x++){let E=_.indices[x];E&&s.isRow(l.data,x*16)&&y.add(E)}let F=_?_.styles.map((x,E)=>y.has(E+1)?w(x):0):void 0,T=new WeakMap;for(let x of d)for(let E of x?.surfaceCharts??[]){let R=E.engraving??(x.sceneMeshId?l.look?.engraving:void 0),C=R&&(typeof R=="object"&&r.get(R)||e.prepare(R));C&&typeof R=="object"&&r.set(R,C),T.set(E,w(C))}if(!m.length)return;let f=[...p.keys()];if(f.some((x,E)=>x!==c[E])||f.length!==c.length){let{params:x,fields:E}=Tu(e,m,0),R=[x,...E].reduce((q,g)=>q+Math.ceil(g.length/8192)*8192,0);if(R/8192>o)throw new RangeError("Surface engraving exceeds the GPU map budget");let C=new Float32Array(R),V=0;for(let q of[x,...E])C.set(q,V),V+=Math.ceil(q.length/8192)*8192;i.upload(C),c=f}return{key:JSON.stringify(f),bind:()=>i.bind(),mesh:x=>T.get(x)??0,curve:x=>F?.[(_?.indices[x]??0)-1]??0,uniforms:{u_engravingTex:14,u_engravingSettings:0,u_engravingLight:e.light(n.engravingLight??[-.45,.8,.55]),u_screenPrintOn:n.screenPrint!==!1,u_brushworkOn:n.brushwork!==!1}}}}var pp=["screen","world","object","view"],dp={dither:"screen",spacing:1,origin:[0,0,0]},vp=e=>[...e.origin,e.spacing,pp.indexOf(e.dither),0,0,0];function Su(e,t,o){let s=t(256,27,o),i=t(2048,25,o),r,c,l,d,n;return(u,m,p,_)=>{let w=m??{...dp,rules:[]},y=[w,...w.rules],F=JSON.stringify(y.map(b=>[b.dither,b.spacing,b.origin,b.object,b.material]));F!==d?(n=Float32Array.from(y.flatMap(vp)),s.upload(n),d=F):s.bind();let T=(b,z)=>y.indexOf(e.matching(w,b,z))+1,f=u.renderMetadata,x=u.reconstructionPose?.base??(u.anim?.base instanceof Float32Array?u.anim.base:u.rest??u.data),E=u.engraving,R=u.splatFootprints?.frames,C=[u,u.count,f,F,x,E,R];if(!l||C.some((b,z)=>b!==l[z])||x===u.data&&p?.length!==0){(!r||r.length!==u.count*16)&&(r=new Float32Array(u.count*16)),c=new Uint8Array(u.count);for(let b=0;b<u.count;b++){let z=b*16,v=b*3,A=b*6,I=T(f?.objects?.[f.objectIds?.[b]],f?.materials?.[f.materialIds?.[b]]);c[b]=I;let ae=E?.indices[b]>0,W=ae?E.anchors.subarray(v,v+3):x.subarray(z,z+3),Z=f?.normals?.subarray(v,v+3)??[0,0,0],S=ae&&E.restFrames.subarray(A,A+6),k=ae&&R?.subarray(A,A+6);r.set([...W,I,...S||[0,0,0,0,0,0],...k||[...Z,0,0,0]],z)}i.upload(r),l=C}else i.bind();let q=e.viewProjection(_),g=[[1,0,0],[0,1,0],[0,0,1]].map(b=>q(...b));return{select:T,slot:b=>c[b]??1,key:F,bindRules:()=>s.bind(),bindSites:()=>i.bind(),uniforms:{u_markRules:27,u_markSites:25,u_markViewX:g.map(b=>b[0]),u_markViewY:g.map(b=>b[1])}}}}var Eu=`
uniform bool u_markPass;
uniform highp sampler2D u_markSites;
flat out vec4 v_markWorld,v_markRest;
flat out vec3 v_markWorldX,v_markWorldY,v_markRestX,v_markRestY;
`,Fu=`
if(u_markPass){
  ivec2 q=ivec2((a_index&511)*4,a_index>>9);
  vec4 a=texelFetch(u_markSites,q,0),b=texelFetch(u_markSites,q+ivec2(1,0),0);
  vec4 c=texelFetch(u_markSites,q+ivec2(2,0),0),d=texelFetch(u_markSites,q+ivec2(3,0),0);
  vec3 referenceU=b.xyz,referenceV=vec3(b.w,c.xy);
  vec3 liveU=vec3(c.zw,d.x),liveV=d.yzw;
  if(dot(referenceU,referenceU)<1e-14){
    vec3 n=liveU;
    if(dot(n,n)<1e-14) n=transpose(mat3(u_view))*vec3(0.,0.,1.);
    n=normalize(n);
    referenceU=normalize(cross(abs(n.x)<.8?vec3(1.,0.,0.):vec3(0.,1.,0.),n));
    referenceV=cross(n,referenceU);
    liveU=referenceU;liveV=referenceV;
  }
  vec3 u=FM*liveU*sc,v=FM*liveV*sc;
  vec2 pu=(T*u).xy,pv=(T*v).xy;
  float det=pu.x*pv.y-pu.y*pv.x;
  v_markWorld=vec4(pos,a.w);v_markRest=vec4(a.xyz,1.);
  v_markWorldX=vec3(0);v_markWorldY=vec3(0);v_markRestX=vec3(0);v_markRestY=vec3(0);
  if(abs(det)>1e-9){
    v_markWorldX=(u*pv.y-v*pu.y)/det;v_markWorldY=(v*pu.x-u*pv.x)/det;
    v_markRestX=(referenceU*pv.y-referenceV*pu.y)/det;v_markRestY=(referenceV*pu.x-referenceU*pv.x)/det;
  }
}
`,zu=`
uniform bool u_markPass;
flat in vec4 v_markWorld,v_markRest;
flat in vec3 v_markWorldX,v_markWorldY,v_markRestX,v_markRestY;
`,Mu=`
if(u_markPass){
  if(v_gl>0.5)discard;
  o=vec4(v_markWorld.xyz+v_markWorldX*v_d.x+v_markWorldY*v_d.y,v_markWorld.w);
  od=vec4(v_markRest.xyz+v_markRestX*v_d.x+v_markRestY*v_d.y,v_markRest.w);
  return;
}
`,Cu=`
uniform highp sampler2D u_markWorld,u_markRest,u_markRules;
uniform vec3 u_markViewX,u_markViewY;
vec2 markView(vec3 p){return vec2(dot(p,u_markViewX),dot(p,u_markViewY));}
vec4 markRule(int slot,int offset){return texelFetch(u_markRules,ivec2(2*(slot-1)+offset,0),0);}
ivec2 markCoordinates(ivec2 pixel,ivec2 screen,vec4 explicitRule,int explicitMode,float scale){
  vec4 world=texelFetch(u_markWorld,pixel,0);
  int slot=int(world.w);
  if(slot<=0)return ivec2(floor(vec2(screen)/scale));
  int mode=explicitMode>=0 ? explicitMode : int(markRule(slot,1).x);
  if(mode==0)return ivec2(floor(vec2(screen)/scale));
  vec4 rule=explicitMode>=0 ? explicitRule : markRule(slot,0);
  vec3 point=(mode==2 ? texelFetch(u_markRest,pixel,0).xyz : world.xyz)-rule.xyz;
  float span=rule.w*scale;
  if(mode==3)return ivec2(floor(markView(point)/span+1e-5));
  ivec3 cell=ivec3(floor(point/span+1e-5));
  return ivec2(dot(vec3(cell),vec3(1,3,2)),dot(vec3(cell),vec3(2,1,3)));
}
ivec2 markCoordinates(ivec2 pixel,ivec2 screen){return markCoordinates(pixel,screen,vec4(0),-1,1.);}
vec3 markPoint(ivec2 pixel,int mode){
  return mode==2 ? texelFetch(u_markRest,pixel,0).xyz : texelFetch(u_markWorld,pixel,0).xyz;
}
float markFootprint(ivec2 pixel,ivec2 step,int slot,int mode,vec3 point){
  ivec2 size=textureSize(u_markWorld,0);
  for(int side=1;side>=-1;side-=2){
    ivec2 neighbor=pixel+step*side;
    if(any(lessThan(neighbor,ivec2(0)))||any(greaterThanEqual(neighbor,size)))continue;
    if(int(texelFetch(u_markWorld,neighbor,0).w)!=slot)continue;
    vec3 delta=markPoint(neighbor,mode)-point;
    return mode==3 ? length(markView(delta)) : length(delta);
  }
  return 0.;
}
float markGain(ivec2 pixel,vec4 rule,int mode,float scale,vec2 fade){
  if(fade.y<=0.)return 1.;
  int slot=int(texelFetch(u_markWorld,pixel,0).w);
  if(mode<0 && slot>0){ mode=int(markRule(slot,1).x); rule=markRule(slot,0); }
  float width=scale;
  if(mode>0&&slot>0){
    vec3 point=markPoint(pixel,mode);
    float footprint=max(markFootprint(pixel,ivec2(1,0),slot,mode,point),
      markFootprint(pixel,ivec2(0,1),slot,mode,point));
    if(footprint<=1e-7)return 1.;
    width=rule.w*scale/footprint;
  }
  if(fade.x==fade.y)return float(width>=fade.y);
  return smoothstep(fade.x,fade.y,width);
}
ivec2 positiveGrid(ivec2 p,ivec2 size){return (p%size+size)%size;}
`;function Pu(e,t,o,s,i){let r=e.getParameter(e.ACTIVE_TEXTURE),c=e.getParameter(e.TEXTURE_BINDING_2D),l=s.table(1024,2,i),d=o.texture(),n=o.texture();e.activeTexture(r),e.bindTexture(e.TEXTURE_2D,c);let u,m,p;function _(){l.bind(),s.textureUnit(1,d),s.textureUnit(6,n)}let w=F=>{if(u!==F.splatFootprints||m!==F.count){let T=p;if(p=t.plan(F),y=p.styles.some(f=>f.depth==="plane"),p.width>i||p.height>i)throw new RangeError("Footprint atlas exceeds the texture limit");p.indices!==T?.indices?l.upload(p.indices):l.bind(),s.textureUnit(1,d),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,64,2,0,e.RGBA,e.FLOAT,p.params),s.textureUnit(6,n),p.atlas!==T?.atlas&&e.texImage2D(e.TEXTURE_2D,0,e.R32F,p.width,p.height,0,e.RED,e.FLOAT,p.atlas),u=F.splatFootprints,m=F.count}else l.bind();return s.textureUnit(1,d),s.textureUnit(6,n),{u_footprintRows:2,u_footprintParams:1,u_footprintAtlas:6,u_footprintColumns:p.columns}},y=!1;return Object.defineProperty(w,"hasPlanes",{get:()=>y}),w.rebind=_,w}function Du(e,{target:t,textureUnit:o,fullscreen:s,copy:i}){let r=t(),c,l,d,n,u,m;function p(w,y,F,T,f=0){e.bindFramebuffer(e.READ_FRAMEBUFFER,w.framebuffer),e.readBuffer(e.COLOR_ATTACHMENT0+f),e.readPixels(0,0,F,T,e.RGBA,e.UNSIGNED_BYTE,y)}function _(w,y,F,T,f,x,{source:E=r,depthRange:R}={}){let C=T*f;n?.length!==C&&(c=new Uint8Array(C*4),l=new Uint8Array(C*4),d=new Uint8Array(C*3),n=new Uint32Array(C),u=new Uint8Array(C)),p(E,c,T,f),p(w,l,T,f);for(let q=0;q<f;q++)for(let g=0;g<T;g++){let b=q*T+g,z=((f-1-q)*T+g)*4;n[b]=l[z]|l[z+1]<<8|l[z+2]<<16,d[3*b]=c[z],d[3*b+1]=c[z+1],d[3*b+2]=c[z+2]}if(y){y!==E&&p(y,l,T,f);let q=y===E?c:l;for(let g=0;g<f;g++)for(let b=0;b<T;b++)u[g*T+b]=+(q[((f-1-g)*T+b)*4+3]<192)}if(R){m?.length!==C&&(m=new Float32Array(C));let[q,g]=R;p(w,l,T,f,2);for(let b=0;b<f;b++)for(let z=0;z<T;z++){let v=((f-1-b)*T+z)*4,A=l[v]|l[v+1]<<8|l[v+2]<<16;m[b*T+z]=l[v+3]>127?q+(g-q)*A/16777215:1/0}}let V=x({w:T,h:f,rgb:d},{splatId:n,protected:y&&u,...R&&{depth:m}});if(o(8,E.textures[0]),V!==d){for(let q=0;q<f;q++)for(let g=0;g<T;g++){let b=(q*T+g)*3,z=((f-1-q)*T+g)*4;c[z]=V[b],c[z+1]=V[b+1],c[z+2]=V[b+2]}e.texSubImage2D(e.TEXTURE_2D,0,0,0,T,f,e.RGBA,e.UNSIGNED_BYTE,c)}s(i,F,T,f,{u_src:8})}return{buffer:r,finish:_}}function Iu(e,{api:t,target:o,textureUnit:s,program:i,fullscreen:r}){let c=o(),l=i(`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_input;
uniform vec2 u_size, u_origin, u_rotation;
uniform float u_cellSize, u_aspect, u_gap;
uniform vec3 u_gapColor;
uniform int u_kind;
out vec4 color;
${t.glsl}
void main(){
  vec3 cell=inkGridCell(vec2(gl_FragCoord.x,u_size.y-gl_FragCoord.y),u_kind,u_cellSize,u_origin,u_rotation,u_aspect);
  ivec2 p=clamp(ivec2(floor(cell.xy)),ivec2(0),ivec2(u_size)-1);
  p.y=int(u_size.y)-1-p.y;
  color=cell.z<u_gap?vec4(u_gapColor,1.0):texelFetch(u_input,p,0);
}`);return function(n,u,m,p,_,w,y){t.dimensions(m,p,_),c.resize(p,_),y(n,u,p,_,c.framebuffer),w||(e.canvas.width!==p&&(e.canvas.width=p),e.canvas.height!==_&&(e.canvas.height=_)),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE),e.disable(e.STENCIL_TEST),e.disable(e.SCISSOR_TEST),e.disable(e.BLEND),e.colorMask(!0,!0,!0,!0),s(0,c.textures[0]),r(l,w,p,_,{u_input:0,u_size:[p,_],u_origin:m.origin,u_rotation:[m.cos,m.sin],u_cellSize:m.size,u_aspect:m.aspect,u_gap:m.gap,u_gapColor:m.gapColor.map(F=>F/255),u_kind:m.kind}),e.activeTexture(e.TEXTURE0)}}var hp=`#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`,mp=`#version 300 es
precision highp float;precision highp int;
uniform highp sampler2D u_matData,u_matSource,u_matBones,u_matBase;
uniform int u_matRows,u_matCount;uniform bool u_matHasBase,u_matOrtho,u_matLiveLight;
uniform vec3 u_matEye,u_matView,u_matLight;uniform float u_matTime;
out vec4 color;
vec4 setting(int id,int slot){int q=id*9+slot;return texelFetch(u_matData,ivec2(q%1024,u_matRows+q/1024),0);}
vec3 unit(vec3 a,vec3 fallback){float l=length(a);return l>1e-8?a/l:fallback;}
mat3 bone(int id,out vec3 translation){int i=id*3;ivec2 p=ivec2(i%768,i/768);vec4 a=texelFetch(u_matBones,p,0),b=texelFetch(u_matBones,p+ivec2(1,0),0),c=texelFetch(u_matBones,p+ivec2(2,0),0);translation=vec3(a.w,b.w,c.w);return transpose(mat3(a.xyz,b.xyz,c.xyz));}
float lobe(vec4 p,vec3 n,vec3 t,vec3 b,vec3 v,vec3 light,float visibility,float steps){
 vec3 h=unit(v+light,n);float nt=dot(n,h);if(dot(n,light)<=0.0||nt<=0.0)return 0.0;
 float ht=dot(t,h),hb=dot(b,h),c=cos(p.w),s=sin(p.w);
 float response=exp(-pow((ht*c+hb*s)/nt/max(.001,p.x),2.0))*exp(-pow((hb*c-ht*s)/nt/max(.001,p.y),2.0));
 float w=clamp(response*p.z*visibility,0.0,1.0);return steps>1.0?floor(w*steps+.5)/steps:w;
}
void main(){ivec2 pixel=ivec2(gl_FragCoord.xy);int i=pixel.x+pixel.y*512;
 vec4 previous=u_matHasBase?texelFetch(u_matBase,pixel,0):vec4(1,1,1,0);
 if(i>=u_matCount){color=vec4(0);return;}
 vec4 normal=texelFetch(u_matData,ivec2(pixel.x*2,pixel.y),0),axis=texelFetch(u_matData,ivec2(pixel.x*2+1,pixel.y),0);
 int id=int(normal.w)-1;ivec2 source=ivec2(pixel.x*4,pixel.y);
 vec4 at=texelFetch(u_matSource,source,0),shape=texelFetch(u_matSource,source+ivec2(2,0),0),animation=texelFetch(u_matSource,source+ivec2(3,0),0);
 int flags=int(shape.w),kind=flags&15;
 if(id<0||at.w<=0.0||(flags&(32768|32))!=0){color=previous;return;}
 vec3 position=at.xyz,n=normal.xyz,t=axis.xyz;mat3 transform=mat3(1);
 float ph=animation.x,sp=animation.y,rg=animation.z,ex=animation.w,time=u_matTime;
 if(kind==5){float a=time*sp,c=cos(a),s=sin(a);transform=mat3(c,0,-s,0,1,0,s,0,c);position=transform*position;}
 else if(kind==12||kind==13){vec3 move;transform=bone(int(ph+.5),move);vec3 p=transform*position+move;
  if(rg>0.0){vec3 move2;mat3 second=bone(int(sp+.5),move2);p=mix(p,second*position+move2,rg);transform=transform*(1.0-rg)+second*rg;}
  position=p;if(kind==13){position.x+=.022*sin(time*1.9+position.y*1.3+position.z*.9+1.0);position.y+=.0132*sin(time*2.47+position.x*1.1+1.0);}}
 else if(kind==6)position.y+=sin(time*sp+ph)*rg;
 else if(kind==8){float f=.2+.8*abs(sin(time*sp+ph));position.x=rg+(position.x-rg)*f;position.z=ex+(position.z-ex)*f;position.y+=.14*sin(time*sp*.31+ph);}
 else if(kind==9)position.xz*=1.0+rg*sin(time*sp+ph-position.y*ex);
 else if(kind==10){float q=length(position.xz),w=min(1.0,q*.22);position.y+=rg*w*sin(time*sp+ph-q*ex);position.xz+=rg*.6*w*vec2(-position.z,position.x)/max(q,.01)*sin(time*sp*.7+ph-q*ex*.6);}
 else if(kind==14){float spread=rg*max(0.0,position.y-ex);position.x+=spread*sin(time*sp+ph);position.z+=spread*.6*sin(time*sp*.73+ph*1.7);}
 else if(kind==2||kind==3||kind==15){float phase=fract(time*sp/max(rg,.000001)+ph);position.y+=(kind==3?1.0:-1.0)*phase*rg;
  if(kind==3)position.x+=sin(phase*7.0+ph*50.0)*.25*phase;
  if(kind==15){position.x+=sin(phase*11.0+ph*40.0)*ex;position.z+=cos(phase*7.0+ph*23.0)*ex*.6;}}
 else if(kind==11){position.x+=rg*sin(time*sp+position.y*1.3+position.z*.9+ph);position.y+=rg*.6*sin(time*sp*1.3+position.x*1.1+ph);}
 if(abs(determinant(transform))>1e-8)n=transpose(inverse(transform))*n;t=transform*t;
 n=unit(n,vec3(0,1,0));t-=n*dot(t,n);t=unit(t,unit(cross(abs(n.x)<.8?vec3(1,0,0):vec3(0,1,0),n),vec3(1,0,0)));
 vec3 b=cross(n,t),v=unit(u_matOrtho?u_matView:u_matEye-position,n),light=unit(u_matLiveLight?u_matLight:setting(id,8).xyz,vec3(0,1,0));
 float packed=texelFetch(u_matSource,source+ivec2(1,0),0).w;
 vec3 original=vec3(mod(packed,256.0),mod(floor(packed/256.0),256.0),floor(packed/65536.0))/255.0;
 vec3 rgb=min(vec3(1),original*(previous.w>0.0?previous.rgb:vec3(1)));
 vec4 diffuse=setting(id,0);rgb*=mix(vec3(1),diffuse.rgb,diffuse.a);
 vec4 sky=setting(id,3),horizon=setting(id,4),ground=setting(id,5);
 float nv=clamp(dot(n,v),0.0,1.0),up=n.y*2.0*nv-v.y,q=clamp(abs(up)/.8,0.0,1.0);q=q*q*(3.0-2.0*q);
 vec3 reflected=mix(horizon.rgb,up<0.0?ground.rgb:sky.rgb,q);
 float reflection=clamp((horizon.a+(1.0-horizon.a)*pow(1.0-nv,ground.a))*sky.a,0.0,1.0);
 rgb=mix(rgb,reflected,reflection);
 vec4 spec=setting(id,1),specColor=setting(id,2),coat=setting(id,6),coatColor=setting(id,7);
 rgb=mix(rgb,specColor.rgb,lobe(spec,n,t,b,v,light,axis.w,specColor.a));
 rgb=mix(rgb,coatColor.rgb,lobe(coat,n,t,b,v,light,axis.w,coatColor.a));
 color=vec4(rgb/max(original,vec3(.00001)),1);
}`;function Lu(e,t,o,s,i){let r=i.KIT,c=i.MaterialControls??r?.material,l=i.SurfaceLook??r?.surface,d=W=>!!W.surfaces?.some(Z=>Z.settings?.materialControls);if(!c||!l)return{has:()=>!1,compose:(W,Z,S,k,M)=>M};let n,u,m,p,_,w,y,F,T,f,x,E,R,C,V,q,g=[],b,z;function v(W,Z){if(W===void 0)return Z;if(Array.isArray(W))return W;let S=typeof W=="string"?parseInt(W.slice(1),16):n.pal[W];return[S>>>16&255,S>>8&255,S&255].map(k=>k/255)}function A(W){let{settings:Z,light:S}=W,k=Z.layers??{},M=["control-diffuse","control-reflection","control-specular","control-coating"],K=l.prepare({...Z,layers:Object.fromEntries(M.map(de=>[de,k[de]]))},n.pal,S,n.surfaceEffects,{paletteRoles:n.paletteRoles}),P=de=>K.layers.find(ye=>ye.id===de),L=P(M[0]),N=P(M[1]),H=P(M[2]),pe=P(M[3]);if(K.layers.some(de=>de.mask||de.drive||de.spatialMask))throw new Error("Native material-control slots do not accept masks or signal drives; add them as separate surface layers");return[...v(L?.color,[1,1,1]),L?.strength??0,...H?.roughness??[.45,.45],H?.strength??0,H?.rotation??0,...v(H?.color,[1,1,1]),H?.steps??Z.steps??0,...v(N?.sky,[.6,.78,.97]),N?.strength??0,...v(N?.horizon,[.86,.91,.97]),N?.f0??.04,...v(N?.ground,[.21,.23,.28]),N?.power??5,...pe?.roughness??[.12,.12],pe?.strength??0,pe?.rotation??0,...v(pe?.color,[1,1,1]),pe?.steps??Z.steps??0,...S??[0,1,0],0]}function I(W,Z){let S=Z.materialRevision??W.materialRevision,k=n!==W||u!==W.data||m!==W.count||y?.length!==W.surfaces.length||p!==W.surfaceData||_!==W.surfaces||w!==S||y?.some((M,K)=>M!==W.surfaces[K].settings);if(k){n=W,u=W.data,m=W.count,p=W.surfaceData,_=W.surfaces,w=S,y=_.map(M=>M.settings),x=Math.ceil(W.count/512),F=new Float32Array((x+Math.ceil(_.length*9/1024))*4096),f=[],_.forEach((M,K)=>{M.settings?.materialControls&&F.set(A(M),x*4096+K*36)});for(let M=0;M<W.count;M++)_[p?.[M*8]-1]?.settings?.materialControls&&f.push(M);E??=o.table(1024,31,s)}if(k||W.anim?.rig||Z.changedRows?.length!==0){let M=W.anim?.rig,K=W.rest??W.anim?.base??W.data,P=new Map;for(let L of f){let N=L*8,H=p[N]-1,pe=_[H].settings,de=[0,1,2].map(Se=>(K[L*16+Se]-(pe.origin?.[Se]??0))/(pe.scale??1)),ye=Array.from(p.subarray(N+1,N+4)),Y=p[N+5]||p[N+6]||p[N+7]?Array.from(p.subarray(N+5,N+8)):pe.direction??[1,0,0],D={x:[1,0,0],y:[0,1,0],z:[0,0,1]};if(typeof Y=="string")Y=D[Y]??D.x;else if(typeof Y=="function")Y=Y(de,ye);else if(Y.type==="circular")Y=r.V.cross(D[Y.axis]??D.y,de);else if(Y.type==="weave"){let Se=D[Y.along]??(Array.isArray(Y.along)?Y.along:D.x),Ae=D[Y.across]??(Array.isArray(Y.across)?Y.across:D.y),B=Y.scale??.2;Y=Math.floor(r.V.dot(Se,de)/B)+Math.floor(r.V.dot(Ae,de)/B)&1?Se:Ae}else Array.isArray(Y)||(Y=D.x);if(!Array.isArray(Y)||Y.length!==3||!Y.every(Number.isFinite))throw new TypeError("Material direction must produce finite XYZ");let _e=M?.free?.[L]?0:M?.bid?.[L];if(_e){let Se=P.get(_e);if(!Se){let Ae=M.M.subarray(_e*12,_e*12+9);Se={A:Ae,normal:Math.abs(r.M.det(Ae))>1e-8?r.M.tr(r.M.inv(Ae)):r.M.id()},P.set(_e,Se)}ye=r.M.app(Se.normal,ye),Y=r.M.app(Se.A,Y)}F.set([...ye,H+1,...Y,p[N+4]],N)}E.upload(F)}else E.bind()}function ae(W,Z,S,k,M){if(Z.materialControls===!1||!W.count||!d(W))return M;if(!q&&!e.getExtension("EXT_color_buffer_float"))throw new Error("Native material controls require EXT_color_buffer_float");try{I(W,Z)}catch(N){throw n=null,N}q??=t.program(hp,mp),V??=t.allocate("VertexArray"),R??=t.texture(),C??=t.texture(),M||(o.textureUnit(21,C),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,1,1,0,e.RGBA,e.FLOAT,new Float32Array([1,1,1,0])));let K=[512,Math.ceil(W.count/512)];(g[0]!==K[0]||g[1]!==K[1])&&(o.textureUnit(31,R),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,...K,0,e.RGBA,e.FLOAT,null),g=K,E.bind());let P=T??=t.allocate("Framebuffer");if(e.bindFramebuffer(e.FRAMEBUFFER,P),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,R,0),e.drawBuffers([e.COLOR_ATTACHMENT0]),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw new Error("Material finish framebuffer is incomplete");z!==W.surfaceLight&&(z=W.surfaceLight,b=z?l.prepareLightTrack(z):null);let L=Z.materialLight??b?.(k);if(L&&(!Array.isArray(L)||L.length!==3||!L.every(Number.isFinite)||Math.hypot(...L)<1e-8))throw new TypeError("Material light needs a nonzero finite XYZ direction");return e.viewport(0,0,...g),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.SCISSOR_TEST),e.colorMask(!0,!0,!0,!0),e.bindVertexArray(V),e.useProgram(q.p),q.set({u_matData:31,u_matSource:0,u_matBones:4,u_matBase:21,u_matRows:x,u_matCount:W.count,u_matHasBase:M,u_matEye:S.eye,u_matView:[S.view[2],S.view[6],S.view[10]],u_matOrtho:S.ortho,u_matTime:k,u_matLight:L??[0,1,0],u_matLiveLight:!!L}),e.drawArrays(e.TRIANGLES,0,3),e.bindFramebuffer(e.FRAMEBUFFER,null),o.textureUnit(21,R),!0}return{has:d,compose:ae}}var Bu=e=>e?.type==="diffuse";function Nu(e,t,o,s,i,r,c,l){if(o.surface===!1||o.diffuseRamps===!1||!t.surfaceData||!t.surfaces?.length||!t.surfaces.some(({settings:R})=>Object.values(R.layers??{}).some(Bu)))return null;let d=e.KIT,n=e.SurfaceLook??d?.surface;if(!n||!d?.splatFrames)throw new Error("Diffuse ramps need the Ink Studio KIT");let u=t.surfaceLight&&n.prepareLightTrack(t.surfaceLight)(i),m=n.lightRamps(o.raw?!1:o.surfaceLightRamps??t.look?.surfaceLightRamps),p=t.surfaces.map(({settings:R,light:C})=>{let V=n.withLightRamps(R,m),q=Object.entries(V.layers??{}).filter(([,b])=>Bu(b));if(!q.length)return null;let g=n.prepare({...V,layers:Object.fromEntries(q),rainRipple:void 0,opacity:void 0},t.pal,u||C,t.surfaceEffects,{paletteRoles:t.paletteRoles,paletteConstraints:!1,facingColors:!1,directionalColors:!1,skipMasks:o.lookMasks===!1,paintShadowBands:o.shadowBandPaint!==!1,shadeNormals:o.shadeNormals!==!1});return g.diffuseLayers?g:null}),_=d.splatFrames.create(t,r,d.M),w=[s.view[2],s.view[6],s.view[10]],y=t.surfaceData,F=n.STRIDE,T=[0,0,0],f=[0,0,0,1,0],x,E;for(let R=0;R<t.count;R++){let C=R*F,V=R*16,q=p[y[C]-1];if(!q||c[V+3]<=0)continue;let g=_(R),b=g.position(),z=c[V+7],v=s.ortho?w:s.eye.map((W,Z)=>W-b[Z]),A=y.subarray(C+1,C+4),I=y.subarray(C+5,C+8),ae={position:g.rest,worldPosition:b,normal:Array.from(A),tangent:I.some(Boolean)?Array.from(I):void 0,view:g.localOffset(...v),lightDirection:d.V.norm(g.localOffset(...q.sun)),shadeNormalFrame:g,shadeNormalLight:q.sun,time:i,visibility:y[C+4]};T[0]=(z&255)/255,T[1]=(z>>>8&255)/255,T[2]=(z>>>16&255)/255,n.shade(q,ae,T,f),x??=c.slice(),x[V+7]=Math.round(f[0]*255)+256*Math.round(f[1]*255)+65536*Math.round(f[2]*255),l&&(E??=t.pix.slice(),E[R*8]=0)}return x?{data:x,pixels:E}:null}var Ni=`
uniform highp sampler2D u_eData,u_eCookies;
uniform highp sampler3D u_eShadow;
uniform int u_eCount,u_eFogCount,u_ePick,u_eCutoutCount;
uniform vec3 u_eShadowMin,u_eShadowSize;
uniform float u_eShadowStep,u_eAmbient;
uniform vec4 u_eSun;
uniform vec3 u_eSunColor;
vec4 eRow(int light,int row){return texelFetch(u_eData,ivec2(light*11+row,0),0);}
vec3 eLinear(vec3 s){return mix(s/12.92,pow((s+.055)/1.055,vec3(2.4)),step(vec3(.04045),s));}
vec3 eSRGB(vec3 s){s=max(s,vec3(0));return mix(s*12.92,1.055*pow(s,vec3(1.0/2.4))-.055,step(vec3(.0031308),s));}
float eShadow(vec3 p,vec3 toLight,float stop,float bias){
  if(u_eShadowStep<=0.0)return 1.0;
  float t=max(bias,u_eShadowStep*.12);
  for(int k=0;k<40;k++){
    if(t>=stop-bias)return 1.0;
    vec3 uv=((p+toLight*t-u_eShadowMin)/u_eShadowStep+.5)/u_eShadowSize;
    if(any(lessThan(uv,vec3(0)))||any(greaterThan(uv,vec3(1)))){t+=u_eShadowStep;continue;}
    float d=texture(u_eShadow,uv).r;
    if(d<max(.0015,u_eShadowStep*.025))return 0.0;
    t+=max(u_eShadowStep*.12,d*.8);
  }
  return 1.0;
}
vec4 eCutoutRow(int i,int row){return texelFetch(u_eData,ivec2(i*6+row,1),0);}
bool eShellSlab(inout vec2 time,float p,float d,float low,float high){
  if(abs(d)<=1e-8)return p>=low&&p<=high;
  float a=(low-p)/d,b=(high-p)/d;
  time=vec2(max(time.x,min(a,b)),min(time.y,max(a,b)));
  return time.x<=time.y;
}
bool eShellHit(vec3 p,vec3 dir,float stop,vec2 depth,vec4 region,vec4 map,float cutoff){
  vec2 time=vec2(1e-5,stop);
  if(!eShellSlab(time,p.x,dir.x,0.0,1.0)||!eShellSlab(time,p.y,dir.y,0.0,1.0)||
     !eShellSlab(time,p.z,dir.z,depth.x,depth.y)||time.x>=stop)return false;
  vec2 base=map.xy+p.xy*map.zw,speed=dir.xy*map.zw;
  ivec2 stride=ivec2(sign(speed)*step(vec2(1e-8),abs(speed)));
  vec2 grid=base+speed*time.x;
  ivec2 size=ivec2(region.zw),cell=clamp(ivec2(
    stride.x<0?ceil(grid.x)-1.0:floor(grid.x),stride.y<0?ceil(grid.y)-1.0:floor(grid.y)),ivec2(0),size-1);
  int count=size.x+size.y+1;
  for(int k=0;k<count;k++){
    ivec2 next=cell+stride;
    float tx=stride.x!=0&&next.x>=0&&next.x<size.x?(float(cell.x+int(stride.x>0))-base.x)/speed.x:1e30;
    float ty=stride.y!=0&&next.y>=0&&next.y<size.y?(float(cell.y+int(stride.y>0))-base.y)/speed.y:1e30;
    float tail=min(time.y,min(tx,ty));
    vec4 texel=round(255.0*texelFetch(u_eCookies,ivec2(region.xy)+cell,0));
    if(tail>=time.x&&texel.a>=cutoff){
      ivec3 bytes=ivec3(texel.rgb);
      int packed=bytes.r+256*bytes.g+65536*bytes.b;
      float back=mix(depth.x,depth.y,float(packed>>12)/4095.0);
      float front=mix(depth.x,depth.y,float(packed&4095)/4095.0);
      vec2 cellTime=vec2(time.x,tail);
      if(eShellSlab(cellTime,p.z,dir.z,back,front)&&cellTime.x<stop)return true;
    }
    if(tail>=time.y)break;
    if(tx<=ty)cell.x=next.x;
    if(ty<=tx)cell.y=next.y;
    time.x=max(time.x,tail);
  }
  return false;
}
float eCutoutShadow(vec3 p,vec3 sampleAt,float endBias){
  if(u_eCutoutCount==0)return 1.0;
  vec3 ray=sampleAt-p;float stop=length(ray);
  if(stop<=endBias+1e-5)return 1.0;
  vec3 dir=ray/stop;
  for(int i=0;i<16;i++){
    if(i>=u_eCutoutCount)break;
    vec4 at=eCutoutRow(i,0),n=eCutoutRow(i,1),u=eCutoutRow(i,2),v=eCutoutRow(i,3);
    vec3 offset=at.xyz-p;
    float facing=dot(dir,n.xyz),axial=dot(offset,n.xyz);
    vec4 region=eCutoutRow(i,4),mapping=eCutoutRow(i,5);
    if(v.w>.5){
      vec3 o=vec3(-dot(offset,u.xyz),-dot(offset,v.xyz),axial);
      vec3 d=vec3(dot(dir,u.xyz),dot(dir,v.xyz),-facing);
      if(eShellHit(o,d,stop-endBias,vec2(n.w,u.w),region,mapping,at.w))return 0.0;
      continue;
    }
    if(abs(facing)<=1e-8)continue;
    float hit=axial/facing;if(hit<=1e-5||hit>=stop-endBias)continue;
    vec3 local=dir*hit-offset;
    vec2 uv=vec2(dot(local,u.xyz),dot(local,v.xyz));
    if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1))))continue;
    ivec2 texel=ivec2(region.xy+clamp(floor(mapping.xy+uv*mapping.zw),vec2(0),region.zw-1.0));
    if(round(255.0*texelFetch(u_eCookies,texel,0).a)>=at.w)return 0.0;
  }
  return 1.0;
}
vec3 eCookie(int i,vec3 p){
  vec4 region=eRow(i,6);if(region.z<=0.0)return vec3(1);
  vec4 at=eRow(i,0),n=eRow(i,1),u=eRow(i,7),v=eRow(i,8),move=eRow(i,9);
  vec3 delta=at.xyz-p;float forward=-dot(delta,n.xyz);if(forward<=0.0)return vec3(0);
  vec2 uv=vec2(.5-dot(delta,u.xyz)/forward,.5-dot(delta,v.xyz)/forward);
  if(any(lessThan(uv,vec2(0)))||any(greaterThanEqual(uv,vec2(1))))return vec3(0);
  uv=(uv-.5)*move.zw+.5+move.xy;if(v.w>.5)uv=fract(uv);
  if(any(lessThan(uv,vec2(0)))||any(greaterThanEqual(uv,vec2(1))))return vec3(0);
  if(u.w<.5)return texelFetch(u_eCookies,ivec2(region.xy+floor(uv*region.zw)),0).rgb;
  vec2 q=uv*region.zw-.5,f=fract(q);ivec2 a=ivec2(floor(q)),lo=ivec2(region.xy),hi=ivec2(region.zw)-1;
  return mix(mix(texelFetch(u_eCookies,lo+clamp(a,ivec2(0),hi),0).rgb,texelFetch(u_eCookies,lo+clamp(a+ivec2(1,0),ivec2(0),hi),0).rgb,f.x),mix(texelFetch(u_eCookies,lo+clamp(a+ivec2(0,1),ivec2(0),hi),0).rgb,texelFetch(u_eCookies,lo+clamp(a+ivec2(1),ivec2(0),hi),0).rgb,f.x),f.y);
}
vec2 eDisk(vec2 a){if(a.x==0.0&&a.y==0.0)return vec2(0);bool wide=abs(a.x)>abs(a.y);float r=wide?a.x:a.y,angle=.78539816339*(wide?a.y/a.x:2.0-a.x/a.y);return r*vec2(cos(angle),sin(angle));}
vec3 eLighting(vec3 p,vec3 normal,bool fog,vec3 viewRay,vec3 biasNormal){
  vec3 sum=vec3(0);
  for(int i=0;i<32;i++){
    if(i>=u_eCount||(fog&&i>=u_eFogCount))break;if(u_ePick>0&&i!=u_ePick-1)continue;
    vec4 c=eRow(i,4),params=eRow(i,5);float power=fog?c.w:params.x;if(power<=0.0)continue;
    vec4 at=eRow(i,0),n=eRow(i,1),u=eRow(i,2),v=eRow(i,3);
    if(distance(p,at.xyz)>at.w+length(vec2(u.w,v.w)))continue;
    vec3 transmission=eCookie(i,p);if(max(transmission.r,max(transmission.g,transmission.b))<=0.0)continue;
    int type=int(n.w),grid=fog?1:int(params.y);float total=0.0,lit=0.0;
    for(int j=0;j<64;j++){
      int count=type==2?grid:type>=3?1:grid*grid;if(j>=count)break;
      vec2 q=vec2(2.0*(float(j%grid)+.5)/float(grid)-1.0,2.0*(float(j/grid)+.5)/float(grid)-1.0);
      if(type==1)q=eDisk(q);if(type==2)q.y=0.0;
      vec3 sampleAt=at.xyz+(type<3?q.x*(type==2?max(0.0,u.w-v.w):u.w)*u.xyz+q.y*v.w*v.xyz:vec3(0));
      vec3 delta=sampleAt-p;float d=length(delta);if(d<=params.w||d>=at.w)continue;vec3 dir=delta/d;
      float facing=-dot(dir,n.xyz),receive=fog?1.0:max(0.0,dot(normal,dir));
      float angular=type>=3?1.0:type==2?1.0:max(0.0,params.z>=2.0?abs(facing):facing);
      if(type==3){float outer=u.w,inner=v.w;if(facing<outer)continue;float edge=inner==outer?1.0:clamp((facing-outer)/(inner-outer),0.0,1.0);angular*=edge*edge*(3.0-2.0*edge);}
      float amount=receive*angular*pow(1.0-d/at.w,2.0);total+=amount;
      bool shadows=mod(params.z,2.0)>.5&&(!fog||eRow(i,10).y>.5);
      vec3 origin=p+(fog?vec3(0):biasNormal*params.w);
      float visible=shadows?eShadow(origin,dir,d,params.w)*eCutoutShadow(origin,sampleAt,fog&&type>=3?0.0:params.w):1.0;
      lit+=amount*visible;
    }
    float count=float(type==2?grid:type>=3?1:grid*grid),visibility=total>0.0?lit/total:0.0;
    float steps=eRow(i,10).x;
    if(steps>1.0)lit=total*floor(visibility*(steps-1.0)+.5)/(steps-1.0);
    sum+=(fog?eSRGB(c.rgb):c.rgb)*transmission*(power*lit/max(count,1.0));
  }
  return sum;
}
vec3 eLighting(vec3 p,vec3 normal,bool fog,vec3 viewRay){return eLighting(p,normal,fog,viewRay,normal);}
vec3 ePaint(vec3 rgb,vec3 p,vec3 n){return eSRGB(min(vec3(1),eLinear(rgb)*(vec3(1)+eLighting(p,n,false,vec3(0)))));}
`,or=(e,t)=>e?.length===t.length&&t.every((o,s)=>o===e[s]),Ou=[1,1,1];function Uu(e,t,{table:o,textureUnit:s},i,r){let c=r.KIT,l=r.AreaLights??c?.areaLights,d=r.LightCookies??c?.lightCookies,n=c?.shadowCutouts;if(!l||!d)return{prepare:()=>null,compose:(G,Q,be,ge,le)=>le,fog:()=>{}};let u=o(352,26,i),m=o(1024,28,i),p=t.texture();s(25,p),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,1,1,0,e.RGBA,e.FLOAT,new Float32Array([1,1,1,0]));let _=t.texture(),w=t.allocate("Texture"),y=t.texture(),F=t.allocate("Framebuffer"),T=t.allocate("VertexArray"),f=t.allocate("Texture"),x,E=[];e.activeTexture(e.TEXTURE0+30),e.bindTexture(e.TEXTURE_2D_ARRAY,f);for(let G of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_2D_ARRAY,G,e.NEAREST);let R,C,V,q,g=[],b,z=[],v,A,I,ae,W,Z,S,k,M,K=0,P=t.allocate("Texture"),L=t.allocate("Framebuffer"),N,H=[],pe,de;e.activeTexture(e.TEXTURE0+25),e.bindTexture(e.TEXTURE_3D,P);for(let G of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,G,e.LINEAR);for(let G of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,G,e.CLAMP_TO_EDGE);e.texImage3D(e.TEXTURE_3D,0,e.RGBA16F,1,1,1,0,e.RGBA,e.FLOAT,new Float32Array([.35,.35,.35,1]));let ye=new WeakMap,Y=new WeakMap,D=1,_e,Se,Ae,B=!1,ie,se;e.activeTexture(e.TEXTURE0+29),e.bindTexture(e.TEXTURE_3D,w);for(let G of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,G,e.LINEAR);for(let G of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,G,e.CLAMP_TO_EDGE);e.texImage3D(e.TEXTURE_3D,0,e.R16F,1,1,1,0,e.RED,e.FLOAT,new Float32Array([1e3]));function ve(G,Q,be,ge=!1,le){let Re=l.prepare(Q.areaLights===!0?G.areaLights:Q.areaLights??G.areaLights,{time:be}),Pe=Q.volumeLighting??G.volumeLighting,Ce=Pe?c.atmosphere.lighting(Pe,G.pal,{time:be}):null,Ee=[...Ce?.point?[Ce.point]:[],...Ce?.locals??[]],ke=[...Re.map(oe=>({...oe,type:oe.shape==="rectangle"?0:oe.shape==="disk"?1:2,surface:oe.intensity,volume:Q.volumeLocalLights===!1?0:oe.volumeIntensity})),...Ee.filter(oe=>oe.intensity||oe.surfaceIntensity).map(oe=>({...oe,type:oe.direction?3:4,normal:oe.direction??[0,0,1],half:[0,0],u:[1,0,0],v:[0,1,0],linearRGB:oe.rgb.map(Xe=>Xe<=.04045?Xe/12.92:((Xe+.055)/1.055)**2.4),surface:oe.surfaceIntensity??0,volume:Q.volumeLocalLights===!1?0:oe.intensity,sampleGrid:1,shadows:oe.castsShadow,bias:.025,cookie:oe.cookie?.projection}))];if(ke.sort((oe,Xe)=>+(Xe.volume>0)-+(oe.volume>0)),ke.length>32)throw new RangeError("Native emitter lighting supports up to 32 active shaped/volume lights");if(!ke.length&&!Pe?.sun&&!G.atmosphere?.some(oe=>oe.lit))return null;if(!e.getExtension("EXT_color_buffer_float"))throw new Error("Native emitter lighting needs EXT_color_buffer_float");let he=ke.some(oe=>oe.shadows)&&n?n.prepare(G,{time:be,interfaceTime:Q.interfaceTime,enabled:Q.cutoutShadows!==!1,shadowShells:Q.shadowShells,surfaces:Q.spriteSurfaces===!1?!1:G.spriteSurfaces,sprites:Q.spriteAtlases===!0?G.spriteAtlases:Q.spriteAtlases??G.spriteAtlases,atlasMode:Q.spriteAtlasMode}):[],te=he.map(oe=>oe.image),ze=[...new Set([...ke.map(oe=>oe.cookie?.image).filter(Boolean),...te])],me=new Map,fe=0,Me=0,we=0,Fe=Math.min(i,1024);for(let oe of ze){if(oe.width>Fe||oe.height>i)throw new RangeError("Light cookie or cutout exceeds native atlas limits");if(fe+oe.width>Fe&&(fe=0,Me+=we,we=0),Me+oe.height>i)throw new RangeError("Light cookie and cutout atlas is full");me.set(oe,[fe,Me,oe.width,oe.height]),fe+=oe.width,we=Math.max(we,oe.height)}let He=Math.max(1,Me+we);if(s(27,_),!or(b,ze)){let oe=new Uint8Array(Fe*He*4);for(let[Xe,[tt,Ye]]of me)for(let Ge=0;Ge<Xe.height;Ge++){let Rt=((Ye+Ge)*Fe+tt)*4;if(Xe.alpha)for(let xt=0;xt<Xe.width;xt++){let yt=Ge*Xe.width+xt,wt=Rt+xt*4,ut=Xe.shell?.data;ut&&(oe[wt]=ut[yt*3],oe[wt+1]=ut[yt*3+1],oe[wt+2]=ut[yt*3+2]),oe[wt+3]=Xe.alpha[yt]}else oe.set(Xe.data.subarray(Ge*Xe.width*4,(Ge+1)*Xe.width*4),Rt)}e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,Fe,He,0,e.RGBA,e.UNSIGNED_BYTE,oe),b=ze}let it=ke.some(oe=>oe.shadows)?l.staticSources(G):[];if(Ce?.shadow?.field){let oe=G.radius??10,Xe={min:[-oe,-oe,-oe],max:[oe,oe,oe]},tt=ye.get(Ce.shadow.field);tt||(tt={distance:Ce.shadow.field,bounds:Xe},ye.set(Ce.shadow.field,tt)),it.push(tt)}(!or(z,it)||Z!==(Q.emitterShadowResolution??48)||S!==Q.emitterShadowRevision)&&(v=l.shadowField(it,{resolution:Q.emitterShadowResolution??48}),z=it,Z=Q.emitterShadowResolution??48,S=Q.emitterShadowRevision,e.activeTexture(e.TEXTURE0+29),e.bindTexture(e.TEXTURE_3D,w),e.texImage3D(e.TEXTURE_3D,0,e.R16F,...v?.size??[1,1,1],0,e.RED,e.FLOAT,v?.data??new Float32Array([1e3]))),e.activeTexture(e.TEXTURE0+29),e.bindTexture(e.TEXTURE_3D,w);let rt=352*4,et=new Float32Array(rt*(he.length?2:1));ke.forEach((oe,Xe)=>{let tt=Xe*44,Ye=oe.cookie;et.set([...oe.at,oe.radius,...oe.normal,oe.type,...oe.u,oe.type===3?oe.outerCos:oe.half[0],...oe.v,oe.type===3?oe.innerCos:oe.half[1],...oe.linearRGB??oe.rgb,oe.volume,oe.surface,oe.points?oe.shape==="line"?oe.points.length:Math.sqrt(oe.points.length):1,(oe.twoSided?2:0)+(oe.shadows?1:0),oe.bias??.025],tt),Ye&&!Y.has(Ye.image)&&Y.set(Ye.image,D++),Ye&&(et.set(me.get(Ye.image),tt+24),et.set([...Ye.u,+(Ye.image.filter==="linear"),...Ye.v,+!!Ye.wrap],tt+28),et.set([...Ye.offset,...Ye.repeat],tt+36)),et.set([oe.shadowSteps??0,+(Q.volumeLocalShadows!==!1),Ye?Y.get(Ye.image):0,0],tt+40)}),he.forEach(({origin:oe,normal:Xe,u:tt,v:Ye,image:Ge,mapping:Rt,cutoff:xt,shellScale:yt=1},wt)=>{let{shell:ut}=Ge;et.set([...oe,xt,...Xe,(ut?.min??0)*yt,...tt,(ut?.max??0)*yt,...Ye,+!!ut,...me.get(Ge),...Rt],rt+wt*24)});let Yt=et.subarray(rt,rt+he.length*24);(!or(k,Yt)||!or(M,te))&&(k=Yt,M=te,K++),u.upload(et);let Zt={u_eData:26,u_eCookies:27,u_eShadow:29,u_eCount:ke.length,u_eCutoutCount:he.length,u_ePick:0,u_eFogCount:ke.filter(oe=>oe.volume>0).length,u_eShadowMin:v?.min??[0,0,0],u_eShadowSize:v?.size??[1,1,1],u_eShadowStep:v?.step??0,u_eAmbient:Ce?.ambient??.35,u_eSun:[...Ce?.sun?.direction??[0,1,0],Ce?.sun?.intensity??0],u_eSunColor:Ce?.sun?.rgb??Ou},ft=Re.filter(oe=>oe.intensity&&(ge?oe.reflection:oe.visible)&&(oe.twoSided||!le||oe.normal.reduce((Xe,tt,Ye)=>Xe+tt*(le.eye[Ye]-oe.at[Ye]),0)>0)),vt=JSON.stringify(ft.map(oe=>[oe.at,oe.normal,oe.u,oe.v,oe.half,oe.rgb,oe.intensity,oe.shape,oe.cookie?.image&&ze.indexOf(oe.cookie.image)]));if(vt!==C||V!==b){let Xe=Math.max(1,ft.length*64),tt=new Uint8Array(Xe*64*4),Ye=[];ft.forEach((Ge,Rt)=>{for(let xt=0;xt<64;xt++)for(let yt=0;yt<64;yt++){let wt=2*(yt+.5)/64-1,ut=1-2*(xt+.5)/64;if(Ge.shape==="disk"?wt*wt+ut*ut>1:Ge.shape==="line"?Math.hypot(Math.max(0,Math.abs(wt)*Ge.half[0]-Math.max(0,Ge.half[0]-Ge.half[1])),ut*Ge.half[1])>Ge.half[1]:!1)continue;let wi=Ge.cookie?d.sample(Ge.cookie.image,(wt+1)/2,(1-ut)/2):Ou,ar=(xt*Xe+Rt*64+yt)*4;for(let $t=0;$t<3;$t++)tt[ar+$t]=Math.round(255*Ge.rgb[$t]*Math.min(1,Ge.intensity)*wi[$t]);tt[ar+3]=255}for(let[xt,yt]of[[0,0],[1,0],[0,1],[0,1],[1,0],[1,1]])Ye.push(...Ge.at.map((wt,ut)=>wt+Ge.u[ut]*(xt*2-1)*Ge.half[0]+Ge.v[ut]*(1-yt*2)*Ge.half[1]),Rt*64+.5+xt*63,.5+yt*63)}),R={width:Xe,height:64,pixels:tt,vertices:Float32Array.from(Ye)},C=vt,V=b}return{areas:Re,count:ke.length,shadow:v,cutoutRevision:K,active:!0,surface:ke.some(oe=>oe.surface>0),uniforms:Zt,areas:Re,rows:et,world:G,frame:Q,time:be,capture:ge,display:R?.vertices.length?R:null}}function j(G,Q,be){if(!G)return;let ge=be.atmosphere===!1?[]:(Q.atmosphere??[]).filter(me=>me.lit);if(!ge.length)return;let le=[1/0,1/0,1/0],Re=[-1/0,-1/0,-1/0],Pe=Q.radius??10;for(let me of ge){let fe=me.min,Me=me.max;!fe&&me.type==="sphere"&&(fe=me.at.map(we=>we-me.radius),Me=me.at.map(we=>we+me.radius)),!fe&&me.type==="shaft"&&(fe=me.from.map((we,Fe)=>Math.min(we,me.to[Fe])-me.radius),Me=me.from.map((we,Fe)=>Math.max(we,me.to[Fe])+me.radius)),fe||(fe=[-Pe,me.bottom??-Pe,-Pe],Me=[Pe,me.top??Pe,Pe]);for(let we=0;we<3;we++)le[we]=Math.min(le[we],fe[we]),Re[we]=Math.max(Re[we],Me[we])}let Ce=be.emitterFogResolution??48;if(!Number.isSafeInteger(Ce)||Ce<8||Ce>128)throw new RangeError("Emitter fog resolution must be 8..128");let Ee=Re.map((me,fe)=>me-le[fe]),ke=Math.max(...Ee)/(Ce-1),he=Ee.map(me=>Math.max(2,Math.ceil(me/ke-1e-9)+1));e.activeTexture(e.TEXTURE0+25),e.bindTexture(e.TEXTURE_3D,P);let te=[...le,...Ee,Ce,G.shadow,G.cutoutRevision,...G.uniforms.u_eSun,...G.uniforms.u_eSunColor,G.uniforms.u_eAmbient],ze=G.rows.subarray(0,G.uniforms.u_eFogCount*44);if(!or(pe,te)||!or(de,ze)){pe=te,de=ze.slice(),or(H,he)||(e.texImage3D(e.TEXTURE_3D,0,e.RGBA16F,...he,0,e.RGBA,e.FLOAT,null),H=he),N??=t.program(`#version 300 es
precision highp float;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`,`#version 300 es
precision highp float;${Ni}
uniform vec3 u_fogMin,u_fogExtent,u_fogSize;uniform int u_fogSlice;out vec4 color;void main(){vec3 p=u_fogMin+vec3(gl_FragCoord.xy-.5,float(u_fogSlice))/(u_fogSize-1.0)*u_fogExtent;vec3 light=vec3(u_eAmbient)+eLighting(p,vec3(0),true,vec3(0));if(u_eSun.w>0.0)light+=u_eSunColor*u_eSun.w*eShadow(p,u_eSun.xyz,20.0,.025);color=vec4(light,1);}`),e.bindFramebuffer(e.FRAMEBUFFER,L),e.drawBuffers([e.COLOR_ATTACHMENT0]),e.viewport(0,0,he[0],he[1]),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.SCISSOR_TEST),e.useProgram(N.p),N.set({...G.uniforms,u_fogMin:le,u_fogExtent:Ee,u_fogSize:he}),e.bindVertexArray(T);for(let me=0;me<he[2];me++)e.framebufferTextureLayer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,P,0,me),N.set({u_fogSlice:me}),e.drawArrays(e.TRIANGLES,0,3);e.bindFramebuffer(e.FRAMEBUFFER,null)}Object.assign(G.uniforms,{u_eFogField:25,u_eFogMin:le,u_eFogExtent:Ee,u_eFogSize:he})}function X(G,Q,be,ge,le){if(!G?.surface||!Q.count)return le;if(_e!==Q||Se!==Q.data||Ae!==Q.renderMetadata){A=null,Se=Q.data,B=!Q.anim;for(let fe=0;fe<Q.count&&B;fe++)B=(Math.round(Q.data[fe*16+11])&15)===0;_e=Q,Ae=Q.renderMetadata}let Re=B&&!Q.anim&&A?.length===Q.count*8&&G.frame.changedRows?.length===0,Pe=A?.length===Q.count*8?A:new Float32Array(Q.count*8);if(!Re){let fe=c.splatFrames.create(Q,be,c.M);for(let Me=0;Me<Q.count;Me++){let we=Me*8,Fe=Me*16,He=fe(Me),it=He.normal,rt=He.position();(Math.round(Q.data[Fe+11])&15)!==0&&(B=!1),Pe.set([...rt,Q.data[Fe+3],...it??[0,0,0],Q.data[Fe+7]],we),(Math.round(Q.data[Fe+11])&352||!it)&&(Pe[we+3]=0)}}A=Pe;let Ce=!or(I,Pe),Ee=le?ge:null;if(!Ce&&or(ae,G.rows)&&(Ee===null?W===null:or(W,Ee))&&ie===v&&se===G.cutoutRevision)return s(21,y),!0;Ce&&(m.upload(Pe),I=Pe.slice());let ke=ae,he=Ce||ie!==v||se!==G.cutoutRevision;ae=G.rows.slice(),W=Ee?.slice()??null,ie=v,se=G.cutoutRevision,le||s(21,p);let te=[512,Math.max(1,Math.ceil(Q.count/512))],ze=`#version 300 es
precision highp float;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;x??=t.program(ze,`#version 300 es
precision highp float;${Ni}
uniform highp sampler2D u_eReceivers;uniform int u_eReceiverCount;out vec4 color;void main(){ivec2 p=ivec2(gl_FragCoord.xy);int i=p.x+p.y*512;if(i>=u_eReceiverCount){color=vec4(0);return;}vec4 at=texelFetch(u_eReceivers,ivec2(p.x*2,p.y),0),n=texelFetch(u_eReceivers,ivec2(p.x*2+1,p.y),0);color=vec4(at.w>0.0?eLighting(at.xyz,normalize(n.xyz),false,vec3(0)):vec3(0),1);}`),q??=t.program(ze,`#version 300 es
precision highp float;${Ni}
uniform highp sampler2D u_eReceivers,u_eBase;uniform highp sampler2DArray u_eBaked;uniform bool u_eHasBase;uniform int u_eReceiverCount;out vec4 color;void main(){ivec2 p=ivec2(gl_FragCoord.xy);int i=p.x+p.y*512;if(i>=u_eReceiverCount){color=vec4(0);return;}vec4 n=texelFetch(u_eReceivers,ivec2(p.x*2+1,p.y),0),base=u_eHasBase?texelFetch(u_eBase,p,0):vec4(1,1,1,0);vec3 light=vec3(0);for(int j=0;j<32;j++){if(j>=u_eCount)break;light+=texelFetch(u_eBaked,ivec3(p,j),0).rgb;}vec3 rgb=vec3(mod(n.w,256.0),mod(floor(n.w/256.0),256.0),floor(n.w/65536.0))/255.0,lit=eSRGB(min(vec3(1),eLinear(rgb)*(vec3(1)+light)));color=vec4(lit/max(rgb,vec3(.00001))*(base.w>0.0?base.rgb:vec3(1)),1);}`);let me=he;if(e.activeTexture(e.TEXTURE0+30),e.bindTexture(e.TEXTURE_2D_ARRAY,f),!or(E,[...te,G.count])){if(te[0]*te[1]*G.count>16777216)throw new RangeError("Emitter receiver lighting exceeds its texel budget");e.texImage3D(e.TEXTURE_2D_ARRAY,0,e.RGBA16F,...te,Math.max(1,G.count),0,e.RGBA,e.FLOAT,null),E=[...te,G.count],me=!0}e.bindFramebuffer(e.FRAMEBUFFER,F),e.drawBuffers([e.COLOR_ATTACHMENT0]),e.viewport(0,0,...te),e.disable(e.DEPTH_TEST),e.disable(e.BLEND),e.disable(e.SCISSOR_TEST),e.colorMask(!0,!0,!0,!0),e.bindVertexArray(T),e.useProgram(x.p),x.set({...G.uniforms,u_eReceivers:28,u_eReceiverCount:Q.count});for(let fe=0;fe<G.count;fe++)!me&&or(ke?.subarray(fe*44,fe*44+44),G.rows.subarray(fe*44,fe*44+44))||(e.framebufferTextureLayer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,f,0,fe),x.set({u_ePick:fe+1}),e.drawArrays(e.TRIANGLES,0,3));if(!or(g,te)){if(s(30,y),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,...te,0,e.RGBA,e.FLOAT,null),e.bindFramebuffer(e.FRAMEBUFFER,F),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,y,0),e.drawBuffers([e.COLOR_ATTACHMENT0]),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw new Error("Emitter lighting target is incomplete");g=te}return e.bindFramebuffer(e.FRAMEBUFFER,F),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,y,0),e.viewport(0,0,...te),e.disable(e.DEPTH_TEST),e.disable(e.BLEND),e.disable(e.SCISSOR_TEST),e.colorMask(!0,!0,!0,!0),e.useProgram(q.p),q.set({...G.uniforms,u_eReceivers:28,u_eBaked:30,u_eBase:21,u_eHasBase:+le,u_eReceiverCount:Q.count}),e.bindVertexArray(T),e.drawArrays(e.TRIANGLES,0,3),s(21,y),e.bindFramebuffer(e.FRAMEBUFFER,null),!0}return{prepare:ve,compose:X,fog:j}}var _p=`#version 300 es
precision highp float;
layout(location=0) in vec3 a_pixel;
layout(location=1) in vec3 a_rgb;
uniform vec2 u_size;
flat out vec3 v_rgb;
flat out float v_depth;
void main() {
  vec2 uv = (a_pixel.xy + .5) / u_size;
  gl_Position = vec4(2.0 * uv.x - 1.0, 1.0 - 2.0 * uv.y, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_depth = a_pixel.z;
  v_rgb = a_rgb;
}`,xp=`#version 300 es
precision highp float;
uniform sampler2D u_ownerDepth;
uniform vec2 u_depthRange;
flat in vec3 v_rgb;
flat in float v_depth;
out vec4 color;
void main() {
  vec4 owner = texelFetch(u_ownerDepth, ivec2(gl_FragCoord.xy), 0);
  float z = dot(round(owner.rgb * 255.0), vec3(1.0, 256.0, 65536.0)) / 16777215.0;
  if (owner.a > .5 && v_depth > mix(u_depthRange.x, u_depthRange.y, z) + .0001) discard;
  color = vec4(v_rgb, 1.0);
}`;function Gu(e,t,o,s){let i=t.program(_p,xp),r=t.allocate("VertexArray"),c=t.allocate("Buffer");e.bindVertexArray(r),e.bindBuffer(e.ARRAY_BUFFER,c);for(let l=0;l<2;l++)e.enableVertexAttribArray(l),e.vertexAttribPointer(l,3,e.FLOAT,!1,24,l*12);return function(d,n,u,m,p,_,w=[]){let y=[],F=(f,x,E,R,C,V)=>y.push(f,x,E,R/255,C/255,V/255);s(d,n,u,F);for(let f of w)F(...f);if(!y.length)return;e.bindFramebuffer(e.FRAMEBUFFER,m),e.viewport(0,0,n,u),e.disable(e.DEPTH_TEST),e.disable(e.BLEND),e.bindVertexArray(r),e.bindBuffer(e.ARRAY_BUFFER,c),e.bufferData(e.ARRAY_BUFFER,Float32Array.from(y),e.DYNAMIC_DRAW),o(3,p),e.useProgram(i.p),i.set({u_size:[n,u],u_ownerDepth:3,u_depthRange:_});let T=e.isEnabled(e.DITHER);e.disable(e.DITHER),e.drawArrays(e.POINTS,0,y.length/6),T&&e.enable(e.DITHER)}}function $u(e,t,o,s){let r=t.allocate("Buffer"),c=t.allocate("VertexArray"),l=o(),d=t.program(`#version 300 es
precision highp float;
layout(location=0) in vec2 a_sample;
uniform vec2 u_size;
flat out vec2 v_sample;
void main(){
  ivec2 at=ivec2(gl_VertexID&255,gl_VertexID>>8);
  gl_Position=vec4((vec2(at)+.5)/u_size*2.-1.,0.,1.);
  gl_PointSize=1.;
  v_sample=a_sample;
}`,`#version 300 es
precision highp float;
uniform highp sampler2D u_depth;
flat in vec2 v_sample;
out vec4 packedDepth;
void main(){
  ivec2 at=ivec2(v_sample);
  packedDepth=texelFetch(u_depth,ivec2(at.x,textureSize(u_depth,0).y-1-at.y),0);
}`);return e.bindVertexArray(c),e.bindBuffer(e.ARRAY_BUFFER,r),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,8,0),function(u,m,p){let _=u.size;if(!_)return new Map;let w=Math.min(256,_),y=Math.ceil(_/256),F=new Float32Array(_*2),T=new Uint8Array(w*y*4),f=0;for(let C of u.values())F.set(C,f),f+=2;l.resize(w,y),e.bindFramebuffer(e.FRAMEBUFFER,l.framebuffer),e.viewport(0,0,w,y),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.bindVertexArray(c),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,F,e.STREAM_DRAW),s(3,m),e.useProgram(d.p),d.set({u_depth:3,u_size:[w,y]});let x=e.isEnabled(e.DITHER);e.disable(e.DITHER),e.drawArrays(e.POINTS,0,_),x&&e.enable(e.DITHER),e.readPixels(0,0,w,y,e.RGBA,e.UNSIGNED_BYTE,T);let E=new Map,R=(p[1]-p[0])/16777215;f=0;for(let C of u.keys())T[f+3]&&E.set(C,p[0]+R*(T[f]+256*T[f+1]+65536*T[f+2])),f+=4;return E}}var Oi=Symbol("inspection depth capture"),yp=`#version 300 es
precision highp float;
uniform sampler2D u_depth;
uniform vec4 u_probes[160];
uniform vec4 u_states[32];
out vec4 color;
void main(){
 int i=int(gl_FragCoord.x);float visible=0.0;
 for(int j=0;j<5;j++){
  if(float(j)>=u_states[i].z)break;
  vec4 p=u_probes[i*5+j];
  float depth=texture(u_depth,vec2(p.x,1.0-p.y)).r;
  visible+=float(u_states[i].y<.5||depth+p.w>=p.z);
 }
 color=vec4(vec3(visible/u_states[i].z*u_states[i].x),1);
}`,gp=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_scene,u_visibility,u_label,u_font;
uniform vec2 u_size,u_anchor;
uniform vec4 u_rect,u_labelRect,u_lens,u_crop,u_ripple;
uniform vec3 u_color;
uniform float u_width,u_corner,u_time,u_period;
uniform int u_slot,u_chars[64],u_count;
out vec4 color;
float segment(vec2 p,vec2 a,vec2 b){vec2 d=b-a;float t=clamp(dot(p-a,d)/max(dot(d,d),.00001),0.0,1.0);return length(p-a-t*d);}
bool inside(vec2 p,vec4 r){return all(greaterThanEqual(p,r.xy))&&all(lessThan(p,r.xy+r.zw));}
void over(vec3 rgb,float a){color=vec4(rgb*a+color.rgb*(1.0-a),a+color.a*(1.0-a));}
void main(){
 float opacity=texelFetch(u_visibility,ivec2(u_slot,0),0).r;if(opacity<=0.0)discard;
 vec2 p=vec2(gl_FragCoord.x,u_size.y-gl_FragCoord.y);color=vec4(0);
 if(u_lens.z>0.0&&inside(p,u_lens)){
  vec2 source=floor(u_crop.xy+(p-u_lens.xy)/u_lens.zw*u_crop.zw);
  over(texture(u_scene,vec2((source.x+.5)/u_size.x,1.0-(source.y+.5)/u_size.y)).rgb,1.0);
 }
 if(u_count>0){
  float cell=u_ripple.w;vec2 grid=floor(p/cell),center=(grid+.5)*cell;
  float radius=min(u_ripple.y,mod(u_time,u_period)*u_ripple.x);
  float wave=max(0.0,1.0-abs(length(center-u_anchor)-radius)/u_ripple.z)*(1.0-radius/u_ripple.y);
  int ch=int(mod(grid.x*13.0+grid.y*7.0+floor(u_time*7.0),float(u_count)));
  int index=u_chars[ch];ivec2 pos=ivec2(mod(p,cell)/cell*vec2(6,8));
  ivec2 texel=ivec2(index%64*6,index/64*8)+pos;
  float bit=texelFetch(u_font,texel,0).r;over(u_color,bit*wave*.65);
 }
 float line=1e6;vec2 a=u_rect.xy,b=a+u_rect.zw;
 for(int j=0;j<4;j++){
  vec2 sign=vec2(j%2==0?1:-1,j<2?1:-1),q=vec2(j%2==0?a.x:b.x,j<2?a.y:b.y);
  line=min(line,segment(p,q,q+vec2(sign.x*min(u_corner,u_rect.z*.5),0)));
  line=min(line,segment(p,q,q+vec2(0,sign.y*min(u_corner,u_rect.w*.5))));
 }
 vec2 delta=abs(p-u_anchor);
 if((delta.x>=3.0&&delta.x<=7.0&&delta.y<=u_width*.5)||(delta.y>=3.0&&delta.y<=7.0&&delta.x<=u_width*.5))line=0.0;
 line=min(line,segment(p,vec2(b.x,a.y),u_labelRect.xy));
 if(u_lens.z>0.0){
  vec2 a=u_lens.xy,b=a+u_lens.zw;
  line=min(line,min(min(segment(p,a,vec2(b.x,a.y)),segment(p,vec2(b.x,a.y),b)),min(segment(p,b,vec2(a.x,b.y)),segment(p,vec2(a.x,b.y),a))));
 }
 if(line<=u_width*.5)over(u_color,1.0);
 if(inside(p,u_labelRect)){
  vec4 label=texelFetch(u_label,ivec2(p-u_labelRect.xy),0);over(label.rgb,label.a);
 }
 color*=opacity;
}`,bp=`#version 300 es
precision highp float;
uniform sampler2D u_scene;
uniform vec2 u_size;
out vec4 color;
void main(){color=texture(u_scene,gl_FragCoord.xy/u_size);}`;function ju(e,{api:t,program:o,resources:s,target:i,textureUnit:r,fullscreen:c,maxSize:l,viewportLimit:d}){let n=i(),u=i(),m=i(),p=s.texture(),_=s.texture(),w=o(yp),y=o(gp),F=o(bp),T=new Map,f,x,E=(R,C,V,q,g=e.RGBA)=>{r(0,R),e.texImage2D(e.TEXTURE_2D,0,g===e.RED?e.R8:e.RGBA8,C,V,0,g,e.UNSIGNED_BYTE,q)};return function(C,V,q,g,b,z,v){if(g>Math.min(l,d[0])||b>Math.min(l,d[1]))throw new RangeError("Inspection frame exceeds texture limit");n.resize(g,b);let A,I=(k,M,K)=>{A={camera:K},m.resize(g,b),r(0,M),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.SCISSOR_TEST),e.colorMask(!0,!0,!0,!0),c(F,m.framebuffer,g,b,{u_scene:0,u_size:[g,b]})};if(v(C,{...V,[Oi]:I},g,b,n.framebuffer),!A)throw new Error("Inspection could not capture the scene camera");let ae=t.plan(q,{world:C,time:V.interfaceTime??V.time??C.lookSnapshot?.time??0,sceneTime:V.time??C.lookSnapshot?.time??0,width:g,height:b,camera:A.camera,focus:V.inspectionFocus});if(z||(e.canvas.width!==g&&(e.canvas.width=g),e.canvas.height!==b&&(e.canvas.height=b)),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.disable(e.SCISSOR_TEST),e.colorMask(!0,!0,!0,!0),r(0,n.textures[0]),c(F,z,g,b,{u_scene:0,u_size:[g,b]}),!ae.targets.length)return;let W=t.font(q);if(f!==W){let k=[...W],M=Math.ceil(k.length/64)*8,K=new Uint8Array(384*M);if(x=new Map,k.forEach(([P,L],N)=>{x.set(P,N);for(let H=0;H<8;H++)K.set(L.subarray(H*6,H*6+6),(Math.floor(N/64)*8+H)*384+N%64*6)}),M>l)throw new RangeError("Inspection glyph atlas exceeds texture limit");E(_,384,M,K,e.RED),f=W,T.clear()}let Z=new Float32Array(640),S=new Float32Array(128);ae.targets.forEach((k,M)=>{Z.set(k.probes.flat(),M*20),S[M*4]=k.coverage,S[M*4+1]=+k.occlusion,S[M*4+2]=k.probes.length}),u.resize(ae.targets.length,1),r(0,m.textures[0]),c(w,u.framebuffer,ae.targets.length,1,{u_depth:0,u_probes:Z,u_states:S}),r(0,n.textures[0]),r(1,u.textures[0]),r(3,_),e.enable(e.BLEND),e.blendEquation(e.FUNC_ADD),e.blendFuncSeparate(e.ONE,e.ONE_MINUS_SRC_ALPHA,e.ONE,e.ONE_MINUS_SRC_ALPHA);for(let k=0;k<ae.targets.length;k++){let M=ae.targets[k],K=JSON.stringify([M.text,M.style,M.label.slice(2)]),P=T.get(K);P||(P=t.labels(M,W),T.size>=128&&T.clear(),T.set(K,P)),E(p,P.w,P.h,P.data),r(2,p),r(0,n.textures[0]);let L=new Int32Array(64),N=[...M.ripple?.chars??""];N.forEach((_e,Se)=>{if(!x.has(_e))throw new RangeError("Missing inspection ripple glyph: "+_e);L[Se]=x.get(_e)});let H=M.ripple,pe=[M.rect,M.label,[M.anchor[0]-(H?.radius??8),M.anchor[1]-(H?.radius??8),(H?.radius??8)*2,(H?.radius??8)*2]];M.lens&&pe.push(M.lens.rect);let de=Math.max(0,Math.floor(Math.min(...pe.map(_e=>_e[0]))-2)),ye=Math.max(0,Math.floor(Math.min(...pe.map(_e=>_e[1]))-2)),Y=Math.min(g,Math.ceil(Math.max(...pe.map(_e=>_e[0]+_e[2]))+2)),D=Math.min(b,Math.ceil(Math.max(...pe.map(_e=>_e[1]+_e[3]))+2));e.enable(e.SCISSOR_TEST),e.scissor(de,b-D,Y-de,D-ye),c(y,z,g,b,{u_scene:0,u_visibility:1,u_label:2,u_font:3,u_size:[g,b],u_anchor:M.anchor,u_rect:M.rect,u_labelRect:M.label,u_lens:M.lens?.rect??[0,0,0,0],u_crop:M.lens?.crop??[0,0,0,0],u_ripple:H?[H.speed,H.radius,H.width,H.cell]:[0,1,1,1],u_period:H?.period??1,u_time:ae.time,u_color:M.style.rgb,u_width:M.style.width,u_corner:M.style.corner,u_slot:k,u_chars:L,u_count:N.length})}e.disable(e.SCISSOR_TEST),e.disable(e.BLEND),e.activeTexture(e.TEXTURE0)}}function qu(e,t,o,s,i,r,c=1/0,l){let d=t.water!==!1&&t.reflections!==!1&&e.water?.reflectionPlanes;if(!d?.length)return null;if(!r)throw new TypeError("Water captures require KIT.reflection in the toolkit");let n=t.reflectionScale??.5,u=t.reflectionMaxSize??512;if(!Number.isFinite(n)||n<=0||n>1||!Number.isSafeInteger(u)||u<1||u>2048)throw new RangeError("Reflection scale must be in (0,1] and max size in [1,2048]");let m=new Map;for(let E of e.reflections??[]){let R=r.plane(E);if(m.has(R.id))throw new RangeError("Duplicate reflection plane "+R.id);m.set(R.id,R)}let p=Math.min(n,u/Math.max(s,i),c/(2*Math.max(s,i))),_=new Float32Array(4),w=new Float32Array(4),y=d.map((E,R)=>{let C=m.get(E);if(!C)throw new RangeError("Unknown water reflection plane "+E);if(Math.abs(C.normal[1]-1)>1e-6)throw new RangeError("Water reflection planes must face up");w[R]=C.at[1];let V=r.captureView(o.view,C,o.eye);if(!V)return null;let q=o.eye.slice();q[1]=2*C.at[1]-q[1];let g=V.equation.slice();return g[3]-=V.bias,{slot:R,plane:C,equation:g,camera:{...o,eye:q,view:V.view}}}).filter(Boolean),F=Math.max(1,Math.round(s*p)),T=Math.max(1,Math.round(i*p)),f=l?.(y.map(E=>E.plane.id)),x=[];for(let E of y){let R=f?.get(E.plane.id)??1;R&&(_[E.slot]=1,x.push({...E,width:Math.max(1,Math.round(F*R)),height:Math.max(1,Math.round(T*R))}))}return{captures:x,active:_,heights:w,count:d.length,width:F,height:T,grid:[2,Math.ceil(d.length/2)]}}function Vu(e,t,o,s){if(!t.select)return e;let i=e.data.slice(),r=s.KIT.splatFrames.create(e,o,s.KIT.M);for(let c=0;c<e.count;c++){let l=r(c).position();t.select(c,...l,e)||(i[c*16+3]=0)}return{...e,data:i}}var wp=`
uniform vec3 u_envEye, u_envRight, u_envUp, u_envBack;
uniform vec4 u_envCamera; // tangent, aspect, orthographic, eye setback
uniform vec2 u_envSkyView;
uniform float u_envHorizon;
vec2 envScreen(vec2 pixel, vec2 size) { return 2.0 * pixel / size - 1.0; }
vec3 envOffset(vec2 p) { return p.x * u_envRight + p.y * u_envUp; }
vec3 envSkyRay(vec2 pixel, vec2 size) {
  return normalize(envOffset(envScreen(pixel,size) * u_envSkyView) - u_envBack);
}
`,kp=`
uniform highp sampler2D u_envData;
vec4 envRow(int index) {
  return texelFetch(u_envData, ivec2(index & 63, index >> 6), 0);
}
`;function Kt(e=!1){return wp+kp+(e?"uniform highp sampler3D u_eFogField;uniform vec3 u_eFogMin,u_eFogExtent,u_eFogSize;vec3 eFogLight(vec3 p){vec3 uv=(clamp((p-u_eFogMin)/u_eFogExtent,vec3(0),vec3(1))*(u_eFogSize-1.0)+.5)/u_eFogSize;return texture(u_eFogField,uv).rgb;}":"")+`
uniform int u_envFogCount, u_envCardSize;
uniform vec4 u_envEntryPlane;
uniform int u_envPaletteFog, u_envPaletteStart, u_envPaletteCard;
vec3 envPalette(vec3 base, int index, vec4 signals) {
  if (index < 0) return base;
  vec4 field = envRow(index);
  if (field.x < 0.5) return base;
  vec4 transfer = envRow(index+1);
  float value = clamp((signals[int(field.y)]-field.z)/field.w,0.0,1.0);
  int first = int(transfer.x), count = int(transfer.y);
  if (field.x < 1.5) {
    for (int i=32; i>=0; i--) {
      if (i >= count) continue;
      vec4 stop = envRow(first+i);
      if (value >= stop.w) return mix(base,stop.rgb,transfer.z);
    }
    return base;
  }
  return mix(base,envRow(first+int(floor(value*float(count-1)+0.5))).rgb,transfer.z);
}
uniform highp sampler2D u_envCard, u_envCloudLight;
uniform float u_envBands, u_envCloudHardness;
float envBand(float value) {
  return u_envBands > 1.0 ? floor(clamp(value,0.0,1.0)*(u_envBands-1.0)+0.5)/(u_envBands-1.0) : value;
}
uniform vec4 u_envCardFrame, u_envCloudStyle, u_envCloudDomain, u_envCloudHeight;
uniform vec3 u_envCardRight, u_envCardUp, u_envCardNormal, u_envCloudRGB, u_envCloudSun, u_envCloudLightRGB;

bool envSlab(inout vec2 hit, float pos, float dir, float lo, float hi) {
  if (abs(dir) < 1e-10) return pos > lo && pos < hi;
  vec2 a = (vec2(lo,hi) - pos) / dir;
  hit = vec2(max(hit.x,min(a.x,a.y)),min(hit.y,max(a.x,a.y)));
  return hit.y > hit.x;
}
bool envRadial(inout vec2 hit, float a, float b, float c) {
  if (a < 1e-10) return c < 0.0;
  float delta = b*b - a*c;
  if (delta <= 0.0) return false;
  float r = sqrt(delta);
  hit = vec2(max(hit.x,(-b-r)/a),min(hit.y,(-b+r)/a));
  return hit.y > hit.x;
}
bool envFogInterval(vec3 origin, vec3 ray, vec2 span, int index, out vec2 hit) {
  vec4 first = envRow(index), second = envRow(index+1), range = envRow(index+3);
  hit = vec2(max(range.x,span.x),min(range.y,span.y));
  if (hit.y <= hit.x) return false;
  if (first.w < 0.5) return envSlab(hit,origin.y,ray.y,first.y,second.y);
  if (first.w < 1.5) return envSlab(hit,origin.x,ray.x,first.x,second.x) &&
    envSlab(hit,origin.y,ray.y,first.y,second.y) && envSlab(hit,origin.z,ray.z,first.z,second.z);
  vec3 offset = origin-first.xyz;
  if (first.w < 2.5) return envRadial(hit,1.0,dot(offset,ray),dot(offset,offset)-range.z*range.z);
  float p = dot(offset,second.xyz), d = dot(ray,second.xyz);
  return envSlab(hit,p,d,0.0,second.w) &&
    envRadial(hit,1.0-d*d,dot(offset,ray)-p*d,dot(offset,offset)-p*p-range.z*range.z);
}
vec4 envFog(vec3 origin, vec3 ray, vec2 span, float setback) {
  const int budget = 32;
  vec2 events[budget];
  int n = 0;
  for (int i=0; i<16; i++) {
    if (i >= u_envFogCount) break;
    vec2 hit;
    if (envFogInterval(origin,ray,span,4*i,hit)) {
      events[n++] = vec2(hit.x,float(i+1));
      events[n++] = vec2(hit.y,-float(i+1));
    }
  }
  for (int i=1; i<budget; i++) {
    if (i >= n) break;
    vec2 value = events[i];
    int j = i;
    for (; j>0; j--) {
      if (events[j-1].x <= value.x) break;
      events[j] = events[j-1];
    }
    events[j] = value;
  }
  vec4 result = vec4(0,0,0,1), medium = vec4(0);
  ${e?"vec3 luminous=vec3(0);":""}
  float last = 0.0;
  int fieldMask = 0;
  float rateFloor = n > 0 ? (events[n-1].x-events[0].x)/64.0 : 0.0;
  for (int i=0; i<budget; i++) {
    if (i >= n) break;
    vec2 event = events[i];
    if (medium.a > 1e-10 && event.x > last) {
      if (fieldMask != 0) {
        float stepSize = event.x-last;
        for (int v=0; v<16; v++) {
          if ((fieldMask & (1 << v)) != 0) stepSize = min(stepSize,envRow(u_envPaletteStart+v*2+1).w);
        }
        stepSize = max(stepSize, max(rateFloor,1e-5));
        for (int j=0; j<64; j++) {
          float from = last+float(j)*stepSize;
          if (from >= event.x) break;
          float distance = min(stepSize,event.x-from), depth = from+distance*0.5;
          vec3 point = origin+ray*depth, color = medium.rgb;
          ${e?"vec3 litColor=luminous;":""}
          for (int v=0; v<16; v++) {
            if ((fieldMask & (1 << v)) == 0) continue;
            vec4 source = envRow(v*4+2);
            vec3 tint = envPalette(source.rgb,u_envPaletteStart+v*2,vec4(max(0.0,depth-setback),point.y,0.0,0.0));
            vec3 change = (tint-source.rgb)*source.a;
            color += change;
            ${e?"if(envRow(v*4+3).w>.5)litColor+=change;":""}
          }
          ${e?"if(dot(litColor,vec3(1))>0.0)color+=litColor*(eFogLight(point)-1.0);":""}
          float alpha = 1.0-exp(-medium.a*distance);
          result.rgb += result.a*alpha*color/medium.a;
          result.a *= 1.0-alpha;
        }
      } else {
      ${e?`if(dot(luminous,vec3(1))>0.0){
        float ds=(event.x-last)/4.0,alpha=1.0-exp(-medium.a*ds);
        for(int j=0;j<4;j++){vec3 p=origin+ray*(last+(float(j)+.5)*ds);vec3 light=eFogLight(p);
          result.rgb+=result.a*alpha*(medium.rgb-luminous+luminous*light)/medium.a;result.a*=1.0-alpha;}
      }else{`:""}
      float alpha = 1.0-exp(-medium.a*(event.x-last));
      result.rgb += result.a * alpha * medium.rgb / medium.a;
      result.a *= 1.0-alpha;
      ${e?"}":""}
      }
    }
    int volumeIndex = int(abs(event.y))-1;
    if (u_envPaletteFog != 0 && envRow(u_envPaletteStart+volumeIndex*2).x > 0.5) {
      int bit = 1 << volumeIndex;
      if (event.y > 0.0) fieldMask |= bit;
      else fieldMask &= ~bit;
    }
    vec4 volume = envRow(4*volumeIndex+2);
    medium += sign(event.y)*vec4(volume.rgb*volume.a,volume.a);
    ${e?"if(envRow(4*(int(abs(event.y))-1)+3).w>.5)luminous+=sign(event.y)*volume.rgb*volume.a;":""}
    last = event.x;
  }
  if (u_envBands > 1.0 && result.a < 1.0) {
    float alpha = 1.0-result.a, styled = envBand(alpha);
    result = vec4(result.rgb*(styled/alpha),1.0-styled);
  }
  return result;
}
vec3 envCardTexel(ivec2 p) {
  if (any(lessThan(p,ivec2(0))) || any(greaterThanEqual(p,ivec2(u_envCardSize)))) return vec3(0);
  return texelFetch(u_envCard,p,0).rgb;
}
float envLightTexel(ivec2 p) {
  if (any(lessThan(p,ivec2(0))) || any(greaterThanEqual(p,textureSize(u_envCloudLight,0)))) return 0.0;
  return texelFetch(u_envCloudLight,p,0).r;
}
float envCone(vec2 point) {
  vec2 xy = (point-u_envCloudDomain.xy)/u_envCloudDomain.zw - 0.5;
  ivec2 p = ivec2(floor(xy));
  vec2 f = fract(xy);
  return mix(mix(envLightTexel(p),envLightTexel(p+ivec2(1,0)),f.x),
    mix(envLightTexel(p+ivec2(0,1)),envLightTexel(p+ivec2(1)),f.x),f.y);
}
vec4 envCard(vec3 origin, vec3 ray, float start, float stop) {
  if (u_envCardSize == 0) return vec4(0,0,0,1);
  float d = -dot(ray,u_envCardNormal);
  if (d <= 1e-8) return vec4(0,0,0,1);
  vec3 delta = u_envCardFrame.xyz-origin;
  float plane = -dot(delta,u_envCardNormal)/d;
  vec3 point = plane*ray-delta;
  vec2 uv = (0.5 + 0.5*vec2(dot(point,u_envCardRight),dot(point,u_envCardUp))/u_envCardFrame.w)*float(u_envCardSize)-0.5;
  ivec2 p = ivec2(floor(uv));
  vec2 f = fract(uv);
  vec3 texel = mix(mix(envCardTexel(p),envCardTexel(p+ivec2(1,0)),f.x),
    mix(envCardTexel(p+ivec2(0,1)),envCardTexel(p+ivec2(1)),f.x),f.y);
  if (texel.x <= 0.0) return vec4(0,0,0,1);
  vec2 span = plane + texel.yz/(texel.x*d);
  vec2 clip = vec2(max(start,span.x),min(stop,span.y));
  if (clip.y <= clip.x) return vec4(0,0,0,1);
  float mass = texel.x*(clip.y-clip.x)/((span.y-span.x)*d);
  float coverage = 1.0-exp(-mass), hardness = u_envCloudHardness;
  if (hardness > 0.5) coverage = clamp(0.5+(coverage-0.5)*(1.0+(hardness-0.5)*13.0),0.0,1.0);
  else if (hardness < 0.5) coverage = mix(coverage,acos(1.0-2.0*coverage)/3.14159265359,1.0-2.0*hardness);
  float alpha = u_envCloudHeight.z*coverage;
  vec3 at = origin + ray * (0.5*(clip.x+clip.y));
  float brightness = 0.0, density = coverage;
  if (u_envCloudHeight.w > 0.0) {
    float y = clamp((at.y-u_envCloudHeight.x)/u_envCloudHeight.y,0.0,1.0);
    density = envCone(at.xz);
    float rim = pow(max(0.0,dot(u_envCloudSun,ray)),12.0);
    float up = envCone(at.xz+u_envCloudSun.xz*u_envCloudHeight.w);
    float relief = clamp(0.52 + 1.45*(density-up),0.0,1.0);
    float light = clamp(u_envCloudStyle.x + u_envCloudStyle.w *
      (u_envCloudStyle.y*(0.24+0.76*relief)*(0.48+0.52*y)+u_envCloudStyle.z*rim),0.0,1.0);
    brightness = light*(0.49+0.51*exp(-mass*0.58));
  }
  vec3 color = envPalette(u_envCloudRGB,u_envPaletteCard,vec4(0.0,at.y,density,brightness));
  color = mix(color,u_envCloudLightRGB,brightness);
  return vec4(alpha*color,1.0-alpha);
}
vec3 envMedia(vec3 color, vec2 pixel, vec2 size, float axialDepth) {
  if (u_envFogCount == 0 && u_envCardSize == 0) return color;
  bool ortho = u_envCamera.z > 0.5;
  vec2 screen = envScreen(pixel,size) * u_envCamera.xy;
  vec3 offset = envOffset(screen);
  float axial = ortho ? 1.0 : inversesqrt(1.0+dot(screen,screen));
  vec3 origin = ortho ? u_envEye+offset : u_envEye;
  vec3 ray = ortho ? -u_envBack : (offset-u_envBack)*axial;
  vec2 span = vec2(0.0, min(axialDepth,u_envHorizon)/axial);
  float side = dot(u_envEntryPlane,vec4(origin,1.0));
  float towards = dot(u_envEntryPlane.xyz,ray);
  if (towards > 1e-7) span.x = max(span.x,-side/towards);
  else if (towards < -1e-7) span.y = min(span.y,-side/towards);
  else if (side < 0.0) return color;
  if (span.x >= span.y) return color;
  if (u_envCardSize > 0) {
    vec4 card = envCard(origin,ray,max(span.x,u_envCamera.w),span.y);
    color = card.rgb + card.a*color;
  }
  if (u_envFogCount > 0) {
    vec4 fog = envFog(origin,ray,span,u_envCamera.w/axial);
    color = fog.rgb + fog.a*color;
  }
  return color;
}
`}var Tp=Kt(),Nn=`
uniform int u_envHasSky, u_envSkySplats, u_envSkyStart, u_envBackdropSampled;
uniform highp sampler2D u_envBackdrop;
uniform vec3 u_envBackground, u_envZenith, u_envSkyHorizon, u_envGround, u_envSun, u_envSunRGB;
uniform vec3 u_envSunParams;
vec3 envBackdrop(vec2 pixel, vec2 size) {
  if (u_envBackdropSampled == 1) {
    vec2 pos = pixel * vec2(textureSize(u_envBackdrop,0)) / size;
    return texelFetch(u_envBackdrop,ivec2(pos),0).rgb;
  }
  if (u_envHasSky == 0) return u_envBackground;
  vec3 ray = envSkyRay(pixel,size);
  float y = ray.y, angle = dot(ray,u_envSun);
  float fade = envBand(y > 0.0 ? sqrt(y) : clamp(-y*3.0,0.0,1.0));
  float disk = y >= 0.0 ? 0.92*clamp((angle-u_envSunParams.x)/max(1e-8,u_envSunParams.y-u_envSunParams.x),0.0,1.0) : 0.0;
  float glow = angle > 0.0 && y >= 0.0 ? 0.22*exp(-19.0*(1.0-angle)) : 0.0;
  vec3 color = mix(mix(u_envSkyHorizon,y > 0.0 ? u_envZenith : u_envGround,fade),u_envSunRGB,
    clamp((disk+glow)*u_envSunParams.z,0.0,1.0));
  for (int i=0; i<u_envSkySplats; i++) {
    int at = u_envSkyStart + i*4;
    vec4 n = envRow(at), r = envRow(at+1), u = envRow(at+2), s = envRow(at+3);
    float z = dot(ray,n.xyz);
    if (z <= 0.0) continue;
    vec2 q = vec2(dot(ray,r.xyz),dot(ray,u.xyz))/(z*vec2(r.w,u.w));
    float d = dot(q,q);
    if (d < 9.0) color = mix(color,s.rgb,n.w*exp(-0.5*d));
  }
  return color;
}
`,Hd=Tp+Nn,Xu=(e=!1)=>Kt(e)+Nn,Wu=(e,t=!1)=>`#version 300 es
precision highp float; precision highp int;
${Kt(t)+Nn}
uniform vec2 u_envViewport;
layout(location=0) out vec4 scene;
layout(location=1) out vec4 depth;
${e?"layout(location=2) out vec4 back; layout(location=3) out vec4 through;":""}
void main() {
  scene = vec4(envMedia(envBackdrop(gl_FragCoord.xy,u_envViewport),gl_FragCoord.xy,u_envViewport,u_envHorizon),1);
  depth = vec4(1,0,0,1);
  ${e?"back = scene; through = vec4(1);":""}
}`;var kr=(e,t,o)=>`
${e?"#define WATER_AIR_POCKETS":""}
uniform highp sampler2D u_waterData;
uniform int u_waterCount;
${t?"#define WATER_LAYERED":""}
${o?"#define WATER_ATLAS":""}
#if defined(WATER_LAYERED) || defined(WATER_ATLAS)
precision highp int;
#endif
#ifdef WATER_ATLAS
uniform int u_waterNodeCount, u_waterBodyBase, u_waterStyleBase;
vec4 waterTexel(int i) {
  int width = textureSize(u_waterData, 0).x;
  return texelFetch(u_waterData, ivec2(i % width, i / width), 0);
}
#else
#ifdef WATER_LAYERED
uniform int u_waterSpanMode[8];
#endif
uniform vec4 u_waterMin[8], u_waterMax[8], u_waterGrid[8];
uniform vec4 u_waterTint[8], u_waterLoss[8], u_waterHighlight[8];
#endif

struct WaterStyle {
  vec4 tint, loss, highlight;
  int index;
  #ifdef WATER_ATLAS
  vec4 deep, sediment, depth;
  #else
  float refraction;
  #endif
};
WaterStyle readWaterStyle(int i) {
  #ifdef WATER_ATLAS
  int at = u_waterStyleBase + i * 6;
  return WaterStyle(waterTexel(at), waterTexel(at + 1), waterTexel(at + 2), i,
    waterTexel(at + 3), waterTexel(at + 4), waterTexel(at + 5));
  #else
  return WaterStyle(u_waterTint[i], u_waterLoss[i], u_waterHighlight[i], i, u_waterMax[i].w);
  #endif
}
uniform mat4 u_waterView;
uniform vec3 u_waterEye;
uniform vec3 u_waterCamera;
uniform vec4 u_arrivalPlane;
uniform float u_waterTime, u_waterWindGain;

// Captures reuse the same body/style index in the column and atlas layouts.
uniform sampler2D u_waterReflections;
uniform int u_waterReflectionBase, u_waterReflectionCount;
uniform vec4 u_waterReflectionActive, u_waterReflectionHeights;
uniform vec2 u_waterReflectionGrid, u_waterReflectionViewport;
uniform mat4 u_waterProjection;
uniform bool u_waterReflectionDetailOn;
vec4 waterReflectionBinding(int index, int width) {
  return texelFetch(u_waterData,ivec2(index % width,index / width),0);
}
vec3 waterReflectionTap(vec2 uv, vec2 tile, vec2 edge) {
  return textureLod(u_waterReflections,(tile+clamp(uv,edge,1.0-edge))/u_waterReflectionGrid,0.0).rgb;
}
vec3 waterReflectionDetail(vec4 shape, vec4 fade, float blur, vec3 view, vec2 uv, vec2 shift, vec2 wave, vec2 tile, vec2 edge) {
  float farWeight = fade.y > fade.x ? smoothstep(fade.x,fade.y,-view.z) : 0.0;
  float core = shape.x*(1.0-farWeight), tail = (1.0-shape.x)*(1.0-farWeight);
  vec3 result = vec3(0.0);
  if (core > 0.0) result += core*waterReflectionTap(uv,tile,edge);
  if (tail > 0.0) {
    vec2 crest = shape.w > 0.5 && length(wave)>1e-8 ? normalize(vec2(wave.y,-wave.x)) : vec2(1.0,0.0);
    float c = cos(fade.w), s = sin(fade.w);
    vec2 turned = vec2(c*crest.x+s*crest.y,c*crest.y-s*crest.x);
    vec3 axis = mat3(u_waterView)*vec3(turned.x,0.0,turned.y);
    vec2 u = axis.xy;
    if (u_waterCamera.z < 0.5) u += view.xy / max(1e-8,-view.z)*axis.z;
    u = length(u)>1e-8 ? normalize(u) : vec2(1.0,0.0);
    vec2 along = u*length(vec2(shape.y,blur))/u_waterReflectionViewport;
    vec2 across = vec2(-u.y,u.x)*length(vec2(shape.z,blur))/u_waterReflectionViewport;
    vec2 p = uv+shift;
    result += tail*(
      waterReflectionTap(p,tile,edge)*0.32+
      (waterReflectionTap(p-along,tile,edge)+waterReflectionTap(p+along,tile,edge))*0.17+
      (waterReflectionTap(p-along*0.5,tile,edge)+waterReflectionTap(p+along*0.5,tile,edge))*0.12+
      (waterReflectionTap(p-across,tile,edge)+waterReflectionTap(p+across,tile,edge))*0.05);
  }
  if (farWeight > 0.0) {
    float cell=fade.z;
    if (cell <= 1.0) result += farWeight*waterReflectionTap(uv,tile,edge);
    else {
      vec2 center=(floor(uv*u_waterReflectionViewport/cell)+0.5)*cell/u_waterReflectionViewport;
      vec2 size=0.5/edge;
      float lod=log2(max(1.0,min(cell*min(size.x/u_waterReflectionViewport.x,size.y/u_waterReflectionViewport.y),
        min(size.x,size.y)*0.25)));
      // Leave room for the coarser mip as well as the finer sample beside an atlas boundary.
      vec2 margin=min(vec2(0.5),edge*exp2(ceil(lod)+1.0));
      vec2 at=(tile+clamp(center,margin,1.0-margin))/u_waterReflectionGrid;
      result += farWeight*textureLod(u_waterReflections,at,lod).rgb;
    }
  }
  return result;
}
vec3 waterReflectedColor(WaterStyle style, vec3 p, vec2 ripple) {
  if (u_waterReflectionCount == 0) return style.highlight.rgb;
  int offset = u_waterReflectionBase + style.index;
  int width = textureSize(u_waterData, 0).x;
  vec4 binding = waterReflectionBinding(offset,width);
  int slot = int(binding.x) - 1;
  if (slot < 0 || u_waterReflectionActive[slot] == 0.0 || abs(p.y-u_waterReflectionHeights[slot]) > 0.002) return style.highlight.rgb;
  vec4 view = u_waterView * vec4(p, 1.0), clip = u_waterProjection * view;
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  vec2 normal = (mat3(u_waterView) * vec3(ripple.x, 0.0, ripple.y)).xy;
  vec2 shift = binding.y * normal / u_waterReflectionViewport;
  vec2 tile = vec2(slot % 2, slot / 2), size = vec2(textureSize(u_waterReflections, 0)) / u_waterReflectionGrid;
  vec2 edge = 0.5 / size;
  if (u_waterReflectionDetailOn && binding.w > 0.0) {
    int detail = int(binding.w);
    return waterReflectionDetail(waterReflectionBinding(detail,width),waterReflectionBinding(detail+1,width),
      binding.z,view.xyz,uv,shift,ripple,tile,edge)*style.highlight.rgb;
  }
  uv += shift;
  vec3 reflected = waterReflectionTap(uv,tile,edge);
  if (binding.z > 0.0) {
    vec2 blur = binding.z / u_waterReflectionViewport;
    reflected *= 0.4;
    reflected += waterReflectionTap(uv+vec2(blur.x,0),tile,edge) * 0.15;
    reflected += waterReflectionTap(uv-vec2(blur.x,0),tile,edge) * 0.15;
    reflected += waterReflectionTap(uv+vec2(0,blur.y),tile,edge) * 0.15;
    reflected += waterReflectionTap(uv-vec2(0,blur.y),tile,edge) * 0.15;
  }
  return reflected * style.highlight.rgb;
}

bool waterSlab(inout vec2 interval, float p, float d, float low, float high) {
  if (abs(d) < 1e-8) return p >= low && p < high;
  vec2 times = (vec2(low, high) - p) / d;
  interval = vec2(max(interval.x, min(times.x, times.y)), min(interval.y, max(times.x, times.y)));
  return interval.x < interval.y;
}

#ifdef WATER_AIR_POCKETS
uniform int u_waterAirCount;
uniform vec4 u_waterAirMin[8], u_waterAirMax[8];

bool airSlab(inout vec2 interval, float p, float d, float low, float high) {
  if (abs(d) < 1e-8) return p > low && p < high;
  return waterSlab(interval, p, d, low, high);
}

bool inAir(float t, vec2 air[8], int count) {
  for (int i = 0; i < 8; i++) {
    if (i >= count || air[i].x > t) break;
    if (t < air[i].y) return true;
  }
  return false;
}

float wetLength(vec2 wet, vec2 air[8], int count) {
  float remaining = wet.y - wet.x;
  float cursor = wet.x;
  for (int i = 0; i < 8; i++) {
    if (i >= count || air[i].x >= wet.y) break;
    float a = max(cursor, air[i].x), b = min(wet.y, air[i].y);
    if (b > a) {
      remaining -= b - a;
      cursor = b;
    }
  }
  return max(0.0, remaining);
}
#endif

void waterSurface(int body, vec3 p, vec3 ray, vec4 column, WaterStyle style, inout vec3 light, inout vec3 through,
                  inout vec3 mark) {
  vec4 highlight = style.highlight;
  vec2 flow = clamp(column.zw, vec2(-4.0), vec2(4.0));
  vec2 position = p.xz - flow * (u_waterTime * 0.25);
  vec2 phase = vec2(dot(position, vec2(3.1, 1.9)), dot(position, vec2(-1.7, 4.4))) +
    u_waterTime * vec2(2.0, -1.6);
  vec2 ripple = sin(phase);
  float grazing = pow(max(0.0, 1.0 - abs(ray.y)), 3.0);
  float foam = (1.0 - smoothstep(0.05, 0.4, column.y - column.x)) *
    smoothstep(0.08, 0.73, (ripple.x + ripple.y) * 0.5) * style.tint.w;
  float reflection = highlight.w * (0.16 + 0.84 * grazing);
  if (highlight.w < 0.0) {
    float f0 = -1.0 - highlight.w;
    reflection = f0 > 0.0 ? f0 + (1.0 - f0) * pow(1.0 - abs(ray.y), 5.0) : 0.0;
  }
  float opacity = clamp(reflection + foam, 0.0, 1.0);
  light += through * mix(waterReflectedColor(style, p, ripple * (1.0 + u_waterWindGain)), vec3(0.9, 0.98, 0.94), foam) * opacity;
  through *= 1.0 - opacity;
  #ifdef WATER_ATLAS
  float refraction = style.deep.w;
  #else
  float refraction = style.refraction;
  #endif
  if (mark.x == 0.0 && refraction > 0.0) {
    vec2 shift = round(ripple * refraction);
    mark = vec3(1.0, float(body) / 255.0, ((shift.x + 4.0) + 9.0 * (shift.y + 4.0)) / 255.0);
  }
}

void waterInterval(int body, vec3 eye, vec3 ray, float limit, float start, float end,
                   vec4 column, bool exposed, bool layered, WaterStyle style, vec2 depthBounds,
                   #ifdef WATER_AIR_POCKETS
                   vec2 air[8], int airCount,
                   #endif
                   inout vec3 light, inout vec3 through, inout vec3 mark,
                   inout float caustic, inout bool surfaceSeen) {
  vec2 wet = vec2(start, end);
  bool horizontal = abs(ray.y) < 1e-8;
  bool inside = (eye.y > column.x || (layered && eye.y == column.x)) && eye.y < column.y;
  if (horizontal ? inside : waterSlab(wet, eye.y, ray.y, column.x, column.y)) {
    float top = horizontal ? -1.0 : (column.y - eye.y) / ray.y;
    bool surface = exposed && (layered || !surfaceSeen) && top >= start && top <= end && top < limit;
    float endpointY = eye.y + ray.y * limit;
    bool endpoint = wet.y == limit && (!layered || (exposed && endpointY >= column.x && endpointY < column.y));
    float distance = wet.y - wet.x;
    #ifdef WATER_AIR_POCKETS
    surface = surface && !inAir(top, air, airCount);
    endpoint = endpoint && !inAir(limit, air, airCount);
    distance = wetLength(wet, air, airCount);
    #endif
    if (surface && ray.y < 0.0)
      waterSurface(body, eye + ray * top, ray, column, style, light, through, mark);
    vec3 transmission = exp(-style.loss.rgb * distance);
    vec3 tint = style.tint.rgb;
    #ifdef WATER_ATLAS
    vec3 center = eye + ray * ((wet.x + wet.y) * 0.5);
    float deep = smoothstep(style.depth.x, style.depth.y, depthBounds.y - center.y);
    tint = mix(tint, style.deep.rgb, deep);
    if (style.sediment.w > 0.0) {
      vec3 drift = vec3(column.z, 0.03, column.w) * u_waterTime;
      vec3 grainPoint = (center - drift) * style.depth.w;
      vec3 bucket = floor(grainPoint), offset = fract(grainPoint) - 0.5;
      float grain = fract(sin(dot(bucket, vec3(2.13, 3.71, 5.73))) * 17368.429);
      float fleck = 1.0 - smoothstep(0.01, 0.19, dot(offset, offset));
      float nearBed = exp(-max(0.0, center.y - depthBounds.x) / style.depth.z);
      float grains = style.sediment.w * (0.22 + 0.78 * fleck * smoothstep(0.65, 0.97, grain)) *
        nearBed * (1.0 - exp(-1.8 * distance));
      light += through * style.sediment.rgb * grains;
      through *= 1.0 - grains * 0.65;
    }
    #endif
    light += through * (1.0 - transmission) * tint;
    through *= transmission;
    if (surface && ray.y > 0.0)
      waterSurface(body, eye + ray * top, ray, column, style, light, through, mark);
    surfaceSeen = surfaceSeen || surface;
    if (endpoint) {
      vec3 p = eye + ray * limit;
      float depth = column.y - p.y;
      vec2 xz = p.xz - clamp(column.zw, vec2(-4.0), vec2(4.0)) * (u_waterTime * 0.17);
      float a = sin(dot(xz, vec2(7.1, 3.8)) + u_waterTime * 2.1);
      float b = sin(dot(xz, vec2(-5.2, 6.4)) - u_waterTime * 1.7);
      caustic = smoothstep(0.78, 0.98, abs(a * b)) * exp(-max(0.0, depth) * 1.2) * style.loss.w;
    }
  }
}

void waterColumns(int body, vec3 eye, vec3 ray, float limit,
                  #ifdef WATER_AIR_POCKETS
                  vec2 air[8], int airCount,
                  #endif
                  inout vec3 light, inout vec3 through,
                  inout vec3 mark, inout float caustic) {
  #ifdef WATER_ATLAS
  int at = u_waterBodyBase + body * 4;
  vec4 low = waterTexel(at), high = waterTexel(at + 1), grid = waterTexel(at + 2);
  int styleId = int(high.w);
  #ifdef WATER_LAYERED
  bool layered = waterTexel(at + 3).x > 0.5;
  #endif
  WaterStyle style = readWaterStyle(styleId);
  #else
  vec4 low = u_waterMin[body], high = u_waterMax[body], grid = u_waterGrid[body];
  #ifdef WATER_LAYERED
  bool layered = u_waterSpanMode[body] == 1;
  #endif
  WaterStyle style = readWaterStyle(body);
  #endif
  vec2 range = vec2(0.0, limit);
  if (!waterSlab(range, eye.x, ray.x, low.x, high.x) ||
      !waterSlab(range, eye.z, ray.z, low.z, high.z)) return;
  vec2 origin = (eye.xz - low.xz) / grid.xy, direction = ray.xz / grid.xy;
  if (abs(ray.x) < 1e-8) direction.x = 0.0;
  if (abs(ray.z) < 1e-8) direction.y = 0.0;
  vec2 crossing = origin + direction * range.x;
  ivec2 count = ivec2(grid.zw), stepCell = ivec2(sign(direction));
  ivec2 cell = ivec2(floor(crossing));
  if (stepCell.x < 0 && crossing.x == floor(crossing.x)) cell.x--;
  if (stepCell.y < 0 && crossing.y == floor(crossing.y)) cell.y--;
  cell = clamp(cell, ivec2(0), count - 1);
  vec2 face = vec2(cell) + max(vec2(stepCell), 0.0);
  vec2 next = vec2(direction.x == 0.0 ? 1e30 : (face.x - origin.x) / direction.x,
                   direction.y == 0.0 ? 1e30 : (face.y - origin.y) / direction.y);
  vec2 stride = vec2(direction.x == 0.0 ? 0.0 : abs(1.0 / direction.x),
                     direction.y == 0.0 ? 0.0 : abs(1.0 / direction.y));
  float start = range.x;
  bool surfaceSeen = false;
  for (int cellStep = 0; cellStep < 128; cellStep++) {
    float end = max(start, min(range.y, min(next.x, next.y)));
    #ifdef WATER_ATLAS
    vec4 column = waterTexel(int(low.w) + cell.y * count.x + cell.x);
    #else
    vec4 column = texelFetch(u_waterData, cell + ivec2(0, int(low.w)), 0);
    #endif
    if (end > start) {
      #ifdef WATER_LAYERED
      if (layered) {
        int first = int(column.x), length = int(column.y);
        for (int i = 0; i < 32; i++) {
          if (i >= length) break;
          int slot = ray.y < 0.0 ? length - 1 - i : i;
          #ifdef WATER_ATLAS
          int offset = first + slot * 2;
          vec4 span = waterTexel(offset), info = waterTexel(offset + 1);
          bool exposed = info.y > 0.5;
          WaterStyle localStyle = style;
          if (int(info.x) != styleId) localStyle = readWaterStyle(int(info.x));
          vec2 depthBounds = info.zw;
          #else
          int width = textureSize(u_waterData, 0).x, offset = first + slot;
          int flags = int(slot < 16 ? column.z : column.w);
          bool exposed = (flags & (1 << (slot % 16))) != 0;
          vec4 span = texelFetch(u_waterData, ivec2(offset % width, offset / width), 0);
          WaterStyle localStyle = style;
          vec2 depthBounds = span.xy;
          #endif
          waterInterval(body, eye, ray, limit, start, end, span, exposed, true, localStyle, depthBounds,
            #ifdef WATER_AIR_POCKETS
            air, airCount,
            #endif
            light, through, mark, caustic, surfaceSeen);
        }
      } else
      #endif
      if (column.y > column.x) waterInterval(body, eye, ray, limit, start, end, column, true, false, style, column.xy,
        #ifdef WATER_AIR_POCKETS
        air, airCount,
        #endif
        light, through, mark, caustic, surfaceSeen);
    }
    if (end >= range.y) break;
    bvec2 crossFace = lessThanEqual(next, vec2(end));
    if (crossFace.x) { cell.x += stepCell.x; next.x += stride.x; }
    if (crossFace.y) { cell.y += stepCell.y; next.y += stride.y; }
    if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, count))) break;
    start = end;
  }
}

vec3 waterPaint(vec3 color, vec2 pixel, vec2 size, float axial, out vec3 mark) {
  mark = vec3(0);
  if (u_waterCount == 0 || axial <= 0.0) return color;
  vec2 plane = (pixel * 2.0 / size - 1.0) * u_waterCamera.xy;
  bool ortho = u_waterCamera.z > 0.5;
  mat3 basis = transpose(mat3(u_waterView));
  vec3 eye = u_waterEye + (ortho ? basis * vec3(plane, 0.0) : vec3(0));
  vec3 direction = basis * vec3(ortho ? vec2(0) : plane, -1.0);
  float rayScale = length(direction);
  vec3 ray = direction / rayScale;
  float limit = axial * rayScale;
  float startSide = dot(u_arrivalPlane, vec4(eye, 1.0));
  if (startSide < 0.0) {
    float into = dot(u_arrivalPlane.xyz, ray);
    if (into <= 0.0) return color;
    float entrance = -startSide / into;
    if (entrance >= limit) return color;
    eye += ray * entrance;
    limit -= entrance;
  }
  #ifdef WATER_AIR_POCKETS
  vec2 air[8];
  int airCount = 0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_waterAirCount) break;
    vec3 low = u_waterAirMin[i].xyz, high = u_waterAirMax[i].xyz;
    vec2 hit = vec2(0.0, 1e30);
    if (!airSlab(hit, eye.x, ray.x, low.x, high.x) || !airSlab(hit, eye.y, ray.y, low.y, high.y) ||
        !airSlab(hit, eye.z, ray.z, low.z, high.z) || hit.x >= limit) continue;
    int at = airCount;
    for (int j = 0; j < 8; j++) {
      if (at <= 0 || air[at - 1].x <= hit.x) break;
      air[at] = air[at - 1];
      at--;
    }
    air[at] = hit;
    airCount++;
  }
  #endif
  vec3 light = vec3(0), through = vec3(1);
  float caustic = 0.0;
  #ifdef WATER_ATLAS
  // Each hit uses a stackless BVH walk bounded by the next nearer entry.
  // Body interiors are disjoint, so its exit is the next search cursor.
  float cursor = 0.0;
  for (int j = 0; j < u_waterCount; j++) {
    int body = -1, node = 0;
    float first = limit, exit = limit;
    while (node < u_waterNodeCount) {
      vec4 low = waterTexel(node * 2), high = waterTexel(node * 2 + 1);
      vec2 hit = vec2(cursor, first);
      if (waterSlab(hit, eye.x, ray.x, low.x, high.x) &&
          waterSlab(hit, eye.y, ray.y, low.y, high.y) &&
          waterSlab(hit, eye.z, ray.z, low.z, high.z)) {
        if (high.w < 0.0) {
          node++;
          continue;
        }
        body = int(high.w);
        first = hit.x;
        // The search bound clips hit.y and must not clip the actual exit.
        vec2 extent = vec2(cursor, limit);
        waterSlab(extent, eye.x, ray.x, low.x, high.x);
        waterSlab(extent, eye.y, ray.y, low.y, high.y);
        waterSlab(extent, eye.z, ray.z, low.z, high.z);
        exit = extent.y;
      }
      node = int(low.w);
    }
    if (body < 0) break;
    waterColumns(body, eye, ray, limit,
      #ifdef WATER_AIR_POCKETS
      air, airCount,
      #endif
      light, through, mark, caustic);
    if (exit >= limit) break;
    cursor = exit;
  }
  #else
  float starts[8];
  for (int i = 0; i < 8; i++) {
    starts[i] = 1e30;
    if (i >= u_waterCount) break;
    vec3 low = u_waterMin[i].xyz, high = u_waterMax[i].xyz;
    vec2 hit = vec2(0.0, limit);
    if (waterSlab(hit, eye.x, ray.x, low.x, high.x) && waterSlab(hit, eye.y, ray.y, low.y, high.y) &&
        waterSlab(hit, eye.z, ray.z, low.z, high.z)) starts[i] = hit.x;
  }
  for (int j = 0; j < 8; j++) {
    int body = -1;
    float first = 1e30;
    for (int i = 0; i < 8; i++) {
      if (i >= u_waterCount) break;
      if (starts[i] < first) { body = i; first = starts[i]; }
    }
    if (body < 0) break;
    starts[body] = 1e30;
    waterColumns(body, eye, ray, limit,
      #ifdef WATER_AIR_POCKETS
      air, airCount,
      #endif
      light, through, mark, caustic);
  }
  #endif
  return light + through * mix(color, vec3(0.93, 1.0, 0.86), caustic);
}
`,wo=(e,t,o,s,i,r=!1)=>`#version 300 es
precision highp float;
${kr(e,t,o)}
uniform vec2 u_waterViewport;
uniform vec3 u_waterBackground;
${s?Xu(r):""}
layout(location=0) out vec4 scene;
layout(location=1) out vec4 depth;
layout(location=2) out vec4 mask;
${i?"layout(location=3) out vec4 back; layout(location=4) out vec4 through;":""}
void main() {
  vec3 mark;
  vec3 source = ${s?"envBackdrop(gl_FragCoord.xy,u_waterViewport)":"u_waterBackground"};
  vec3 color = waterPaint(source,gl_FragCoord.xy,u_waterViewport,400.0,mark);
  ${s?"color = envMedia(color,gl_FragCoord.xy,u_waterViewport,u_envHorizon);":""}
  scene = vec4(color,1);
  depth = vec4(1, 0, 0, 1);
  mask = vec4(mark, 1);
  ${i?"back = scene; through = vec4(1);":""}
}`;var Hu=`uniform int u_engravingRows,u_engravingSettings;
uniform vec3 u_engravingLight;
flat out vec4 v_engravingAnchor,v_engravingX,v_engravingY,v_engravingRestNormal;
flat out vec3 v_brushTangent;
vec4 engravingData(int texel){return texelFetch(u_data,ivec2(texel%2048,texel/2048),0);}
`,Ku=`
 int eq=u_engravingRows*2048+a_index*4;
 vec4 ea=engravingData(eq),eb=engravingData(eq+1),ec=engravingData(eq+2),ed=engravingData(eq+3);
 int slot=(kraw&(32|256|32768))!=0?0:int(ea.x);v_engravingAnchor=vec4(ea.yzw,float(slot));v_engravingX=vec4(0);v_engravingY=vec4(0);v_engravingRestNormal=vec4(0,1,0,fogk);v_brushTangent=vec3(0.);
 if(slot>0){
  vec3 ru=eb.xyz,rv=ec.xyz,lu=vec3(eb.w,ec.w,ed.x),lv=ed.yzw;
  vec3 wu=FM*lu*sc,wv=FM*lv*sc;vec2 pu=(T*wu).xy,pv=(T*wv).xy;float area=pu.x*pv.y-pu.y*pv.x;
  if(abs(area)>1e-10&&length(cross(wu,wv))>1e-10){
   v_engravingX.xyz=(ru*pv.y-rv*pu.y)/area;v_engravingY.xyz=(-ru*pv.x+rv*pu.x)/area;
   int at=u_engravingSettings*2048+(slot-1)*9;vec4 info=engravingData(at),settings=engravingData(at+1),paper=engravingData(at+3),axis=engravingData(at+5);
   float footprint=max(length(v_engravingX.xyz),length(v_engravingY.xyz));
   vec3 normal=normalize(cross(ru,rv));
   if(info.x==0.){
    v_engravingRestNormal.xyz=normal;
    v_brushTangent=normalize(ru);
    v_engravingX.w=footprint*u_materialGridScale;
   }else{
    v_engravingRestNormal.xyz=normal;
    v_engravingX.w=clamp(log2(max(1e-8,footprint*info.y/settings.x))+axis.w,0.,3.);
   }
   v_engravingY.w=1.-clamp(paper.w+(1.-paper.w)*max(0.,dot(normalize(cross(wu,wv)),normalize(u_engravingLight))),0.,1.);
  }else v_engravingAnchor.w=0.;
 }
`,Yu=`vec4 engravingFetch(int texel){return texelFetch(ENGRAVING_TABLE,ivec2(texel%2048,texel/2048),0);}
vec4 screenPrintFetch(int texel){return engravingFetch(texel);}
/*SCREEN_PRINT*/
vec4 engravingSetting(int slot,int row){return engravingFetch(u_engravingSettings*2048+(slot-1)*9+row);}
vec4 engravingTile(int start,int n,int group,vec2 uv){
 vec2 q=fract(uv)*float(n)-.5;ivec2 at=ivec2(floor(q));vec2 f=fract(q);
 ivec2 a=(at+ivec2(n))%n,b=(at+ivec2(n+1))%n;int page=group*n*n;
 return mix(mix(engravingFetch(start+page+a.y*n+a.x),engravingFetch(start+page+a.y*n+b.x),f.x),mix(engravingFetch(start+page+b.y*n+a.x),engravingFetch(start+page+b.y*n+b.x),f.x),f.y);
}
float engravingMip(int start,int n,int mip,float tone,vec2 uv){
 int offset=0;for(int i=0;i<2;i++){if(i>=mip)break;offset+=2*n*n;n/=2;}
 int lo=int(floor(tone)),hi=min(7,lo+1),a=lo/4,b=hi/4;
 vec4 p=engravingTile(start+offset,n,a,uv),q=a==b?p:engravingTile(start+offset,n,b,uv);
 return mix(p[lo%4],q[hi%4],fract(tone));
}
float engravingMap(vec4 info,vec2 uv,float tone,float lod){
 int lo=min(2,int(floor(lod))),hi=min(2,lo+1),start=int(info.x)*2048;
 float first=engravingMip(start,int(info.y),lo,tone,uv);
 return lo==hi?first:mix(first,engravingMip(start,int(info.y),hi,tone,uv),fract(min(lod,2.)));
}
uint brushHash(ivec3 p,uint seed){
 uvec3 q=uvec3(p);
 uint n=(q.x*0x8da6b343u)^(q.y*0xd8163841u)^(q.z*0xcb1ab31fu)^seed;
 n=(n^(n>>16u))*0x7feb352du;
 n=(n^(n>>15u))*0x846ca68bu;
 return n^(n>>16u);
}
float brushByte(uint code,uint shift){return float((code>>shift)&255u)/255.;}
float brushPigment(vec3 q,uint seed){
 ivec3 cell=ivec3(floor(q));vec3 f=smoothstep(vec3(0.),vec3(1.),fract(q));
 float pigment=0.;
 for(int x=0;x<2;x++)for(int y=0;y<2;y++)for(int z=0;z<2;z++){
  ivec3 corner=ivec3(x,y,z);vec3 weight=mix(1.-f,f,vec3(corner));
  pigment+=weight.x*weight.y*weight.z*brushByte(brushHash(cell+corner,seed),24u);
 }
 return pigment;
}
float brushDetail(vec3 q,float width,uint seed,vec3 n,vec3 u){
 ivec3 cell=ivec3(floor(q));vec3 f=fract(q),v=cross(n,u);
 float pigment=0.,total=0.;
 for(int x=0;x<2;x++)for(int y=0;y<2;y++)for(int z=0;z<2;z++){
  ivec3 corner=ivec3(x,y,z);uint h=brushHash(cell+corner,seed);
  vec3 variance=vec3(brushByte(h,0u),brushByte(h,8u),brushByte(h,16u));
  vec3 d=f-vec3(corner)-.12*(variance-.5);
  float along=dot(d,u)/(.68+.2*variance.y);
  if(abs(along)>=1.)continue;
  vec3 brush=vec3(along,dot(d,v)/(width*(.8+.4*variance.z)),dot(d,n)/.68);
  float weight=1.-smoothstep(.54,1.,dot(brush,brush));
  pigment+=weight*(brushByte(h,24u)-.5);total+=weight;
 }
 return pigment/max(1.,total);
}
float brushCoverage(vec3 q,uint seed,vec4 shape,float groupScale,float pixels,float tone,vec3 n,vec3 u){
 float groupSize=smoothstep(.65,1.8,pixels*groupScale),grain=smoothstep(shape.y,shape.z,2.*shape.x*pixels);
 if(groupSize*shape.w>0.)
  tone+=shape.w*groupSize*(smoothstep(.24,.76,brushPigment(q/groupScale,seed^0x9e3779b9u))-.5);
 if(grain>0.)tone+=grain*.9*brushDetail(q,shape.x,seed,n,u);
 return clamp(tone,0.,1.);
}
vec3 applyEngraving(int slot,vec3 rgb,vec3 point,vec3 normal,vec3 tangent,float footprint,
  float shade,float brushFootprint,float fogAmount,vec3 fogColor){
 if(slot<=0)return rgb;
 vec4 info=engravingSetting(slot,0),settings=engravingSetting(slot,1),ink=engravingSetting(slot,2),paper=engravingSetting(slot,3),origin=engravingSetting(slot,4);
 if(ink.w<=0.)return rgb;
 vec3 p=point-origin.xyz;
 vec3 litRGB=fogAmount<.999?clamp((rgb-fogColor*fogAmount)/(1.-fogAmount),0.,1.):rgb;
 vec3 w=pow(abs(normal),vec3(8));w/=max(1e-8,w.x+w.y+w.z);
 if(info.x<0.){
  if(!u_screenPrintOn)return rgb;
  int start=int(-info.x)*2048;vec3 printed=vec3(0.);
  if(info.y>.5)printed=screenPrintShade(start,vec2(0.),litRGB,footprint,1.-shade);
  else if(info.z>2.5){if(w.x>.001)printed+=w.x*screenPrintShade(start,p.yz,litRGB,footprint,1.-shade);if(w.y>.001)printed+=w.y*screenPrintShade(start,p.zx,litRGB,footprint,1.-shade);if(w.z>.001)printed+=w.z*screenPrintShade(start,p.xy,litRGB,footprint,1.-shade);}
  else{vec3 along=engravingSetting(slot,5).xyz,across=engravingSetting(slot,6).xyz;float x=dot(p,along),y=dot(p,across),z=dot(p,cross(along,across));vec2 uv=vec2(x,y);if(info.z>.5)uv=vec2(atan(z,x)*origin.w,info.z>1.5?atan(y,length(vec2(x,z)))*origin.w:y);printed=screenPrintShade(start,uv,litRGB,footprint,1.-shade);}
  return mix(printed,fogColor,fogAmount);
 }
 float lit=shade,lum=1.-clamp(dot(litRGB,vec3(.2126,.7152,.0722)),0.,1.);
 float darkness=info.w<.5?lit:info.w<1.5?lum:lit*.65+lum*.35;
 float tone=clamp(clamp((darkness-.5)*settings.z+.5+settings.w,0.,1.)*settings.y,0.,1.);
 if(info.x==0.){
  if(!u_brushworkOn)return rgb;
  uint seed=uint(info.y)|(uint(info.z)<<24u);
  float pixels=settings.x/max(1e-8,brushFootprint),groupScale=engravingSetting(slot,5).w;
  float coverage=brushCoverage(p/settings.x,seed,engravingSetting(slot,6),groupScale,pixels,tone,normal,tangent);
  return mix(rgb,mix(mix(paper.rgb,ink.rgb,coverage),fogColor,fogAmount),ink.w);
 }
 tone*=7.;float lod=clamp(log2(max(1e-8,footprint*info.y/settings.x))+engravingSetting(slot,5).w,0.,3.),coverage=0.;
 if(info.z>2.5){if(w.x>.001)coverage+=w.x*engravingMap(info,p.yz/settings.x,tone,lod);if(w.y>.001)coverage+=w.y*engravingMap(info,p.zx/settings.x,tone,lod);if(w.z>.001)coverage+=w.z*engravingMap(info,p.xy/settings.x,tone,lod);}
 else{vec3 along=engravingSetting(slot,5).xyz,across=engravingSetting(slot,6).xyz;float x=dot(p,along),y=dot(p,across),z=dot(p,cross(along,across));vec2 uv=vec2(x,y);if(info.z>.5)uv=vec2(atan(z,x)*origin.w,info.z>1.5?atan(y,length(vec2(x,z)))*origin.w:y);coverage=engravingMap(info,uv/settings.x,tone,lod);}
 if(lod>2.){int t=int(floor(tone));vec4 a=engravingSetting(slot,7),b=engravingSetting(slot,8);float m0=t<4?a[t]:b[t-4];int t1=min(7,t+1);float m1=t1<4?a[t1]:b[t1-4];coverage=mix(coverage,mix(m0,m1,fract(tone)),lod-2.);}
 return mix(rgb,mix(mix(paper.rgb,ink.rgb,coverage),fogColor,fogAmount),ink.w);
}
`,Zu=`
uniform highp sampler2D u_data;uniform int u_engravingSettings;uniform vec3 u_engravingLight;uniform bool u_screenPrintOn,u_brushworkOn;
flat in vec4 v_engravingAnchor,v_engravingX,v_engravingY,v_engravingRestNormal;
flat in vec3 v_brushTangent;
#define v_engravingSlot int(v_engravingAnchor.w)
#define ENGRAVING_TABLE u_data
${Yu}
vec3 engravingShade(vec3 rgb,vec2 offset){
  vec3 p=v_engravingAnchor.xyz+v_engravingX.xyz*offset.x+v_engravingY.xyz*offset.y;
  float footprint=max(length(v_engravingX.xyz),length(v_engravingY.xyz));
  return applyEngraving(v_engravingSlot,rgb,p,v_engravingRestNormal.xyz,v_brushTangent,footprint,v_engravingY.w,
    v_engravingX.w,clamp(v_engravingRestNormal.w,0.,1.),u_fog);
}
`;function ko(e){return`
uniform highp sampler2D u_engravingTex;uniform int u_engravingSettings;uniform vec3 u_engravingLight;uniform bool u_screenPrintOn,u_brushworkOn;
#define ENGRAVING_TABLE u_engravingTex
${Yu.replace("/*SCREEN_PRINT*/",e??"vec3 screenPrintShade(int id,vec2 uv,vec3 rgb,float f,float lit){return rgb;}")}
vec3 surfaceEngraving(int slot,vec3 rgb,vec3 point,vec3 restNormal,vec3 tangent,vec3 normal,float footprint,
  float artScale,float fogAmount,vec3 fogColor){
  if(slot<=0)return rgb;
  float ambient=engravingSetting(slot,3).w;
  float shade=1.-clamp(ambient+(1.-ambient)*max(0.,dot(normal,normalize(u_engravingLight))),0.,1.);
  return applyEngraving(slot,rgb,point,restNormal,tangent,footprint,shade,footprint*artScale,fogAmount,fogColor);
}
`}var Rp=`
const float farRay = 1e20;
bool clipRay(vec4 plane, vec3 origin, vec3 ray, inout vec2 interval) {
  float offset = dot(plane,vec4(origin,1)), slope = dot(plane.xyz,ray);
  if (abs(slope) < 1e-8) return offset >= -1e-7;
  if (slope > 0.0) interval.x = max(interval.x,-offset/slope);
  else interval.y = min(interval.y,-offset/slope);
  return interval.x <= interval.y;
}
bool projectedCap(vec4 plane, vec3 point, vec3 origin, vec3 ray) {
  float facing = dot(plane.xyz,ray);
  return abs(facing) >= 1.0-1e-7 ||
    dot(plane,vec4(origin,1))-facing*dot(origin-point,ray) >= -1e-7;
}
float sphereEntry(vec3 center, vec3 ray, float radius, float near) {
  float at = dot(center,ray);
  vec3 offset = center-at*ray;
  float disc = radius*radius-dot(offset,offset);
  if (disc < 0.0) return farRay;
  float reach = sqrt(disc);
  return at+reach < near ? farRay : max(near,at-reach);
}
float capsuleEntry(vec3 start, vec3 ray, vec3 axis, float span, float radius, float near) {
  float shift = dot(start,axis), tilt = dot(ray,axis);
  float first = min(sphereEntry(start,ray,radius,near),sphereEntry(start+span*axis,ray,radius,near));
  if (first == near) return near;
  vec3 origin = start-shift*axis, direction = ray-tilt*axis;
  float a = dot(direction,direction), b = dot(origin,direction), c = dot(origin,origin)-radius*radius;
  float along = near*tilt-shift;
  if (along >= 0.0 && along <= span && a*near*near-2.0*b*near+c <= 0.0) return near;
  float disc = b*b-a*c;
  if (a > 1e-15 && disc >= 0.0) {
    float t = (b-sqrt(disc))/a;
    along = t*tilt-shift;
    if (t >= near && along >= 0.0 && along <= span) first = min(first,t);
  }
  return first;
}
float boxEntry(vec3 low, vec3 high, vec3 ray, float near) {
  float enter = near, leave = farRay;
  for (int k=0; k<3; k++) {
    if (abs(ray[k]) < 1e-8) {
      if (low[k] > 0.0 || high[k] < 0.0) return farRay;
    } else {
      float a = low[k]/ray[k], b = high[k]/ray[k];
      enter = max(enter,min(a,b)); leave = min(leave,max(a,b));
      if (enter > leave) return farRay;
    }
  }
  return enter;
}
float hardEntry(vec3 start, vec3 ray, vec3 along, float span, float radius, bool flattened, float near) {
  if (!flattened) return capsuleEntry(start,ray,along,span,radius,near);
  float halfWidth = 3.0*radius;
  vec3 low = start-vec3(0,halfWidth,0), high = start+vec3(0,halfWidth,0);
  float enter = boxEntry(low-vec3(0,0,radius),high+vec3(span,0,radius),ray,near);
  enter = min(enter,capsuleEntry(low,ray,along,span,radius,near));
  enter = min(enter,capsuleEntry(high,ray,along,span,radius,near));
  vec3 crossAxis = vec3(0,1,0);
  enter = min(enter,capsuleEntry(low,ray,crossAxis,2.0*halfWidth,radius,near));
  return min(enter,capsuleEntry(low+vec3(span,0,0),ray,crossAxis,2.0*halfWidth,radius,near));
}
float erfCurve(float x) {
  float t = 1.0/(1.0+.3275911*abs(x));
  float p = ((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t;
  return sign(x)*(1.0-p*exp(-x*x));
}
float primitive(float x) {
  float s = x*x;
  return (x*sqrt(max(0.0,1.0-s))*(33.0-26.0*s+8.0*s*s)+15.0*asin(x))/48.0;
}
// The result is optical mass and its representative station in world units.
vec2 integrated(vec3 start, vec3 tangent, float span, float radius, bool beta) {
  float transverse = length(tangent), reach = radius*(beta ? sqrt(6.0) : sqrt(2.0));
  if (transverse*span < 1e-4*reach) {
    float at = span*.5, q = dot(start+at*tangent,start+at*tangent)/(reach*reach);
    float profile = beta ? pow(max(0.0,1.0-q),2.5) : exp(-q);
    return vec2(profile*span/(beta ? reach*.9817477042 : radius*2.5066282746),at);
  }
  float center = -dot(start,tangent)/(transverse*transverse);
  vec3 delta = start+center*tangent;
  float q = dot(delta,delta)/(reach*reach), at = clamp(center,0.0,span);
  if (beta) {
    if (q >= 1.0) return vec2(0);
    float scale = transverse/(reach*sqrt(1.0-q));
    float lo = max(-1.0,-center*scale), hi = min(1.0,(span-center)*scale);
    return vec2(hi > lo ? pow(1.0-q,3.0)*(primitive(hi)-primitive(lo))/(transverse*.9817477042) : 0.0,at);
  }
  float lo = -center*transverse/reach, hi = (span-center)*transverse/reach;
  if (q > 12.96 || lo >= 4.0 || hi <= -4.0) return vec2(0);
  return vec2(exp(-q)*(erfCurve(hi)-erfCurve(lo))/(2.0*transverse),at);
}
const float circlePoints[7] = float[7](-.9491079123,-.7415311856,-.4058451514,0.0,.4058451514,.7415311856,.9491079123);
const float circleMass[7] = float[7](.1294849662,.2797053915,.3818300505,.4179591837,.3818300505,.2797053915,.1294849662);

uniform highp sampler2D u_curveSpans;
vec4 spanRow(int id, int field) {
  int texel = id*10+field;
  return texelFetch(u_curveSpans,ivec2(texel & 511,texel >> 9),0);
}
struct Hit { int row; float depth; float exitDepth; float alpha; float group; };
bool curveHit(int id, vec3 origin, vec3 ray, vec2 viewInterval, out Hit hit) {
  vec4 a = spanRow(id,0), b = spanRow(id,1), major = spanRow(id,2), minor = spanRow(id,3);
  vec4 capStart = spanRow(id,4), capEnd = spanRow(id,5), meta = spanRow(id,7);
  int mode = int(major.w);
  bool hard = (mode & 2) != 0, flattened = (mode & 8) != 0, beta = (mode & 1) != 0;
  if (hard) {
    if (!clipRay(capStart,origin,ray,viewInterval) || !clipRay(capEnd,origin,ray,viewInterval)) return false;
  } else if (!projectedCap(capStart,spanRow(id,8).xyz,origin,ray) || !projectedCap(capEnd,spanRow(id,9).xyz,origin,ray)) return false;
  vec3 from = a.xyz-origin, start = from, axis = b.xyz, along = axis, direction = ray;
  float axial = -ray.z, scale = 1.0;
  if ((mode & 4) != 0) {
    float blur = flattened ? .25 : 1.0;
    start = vec3(dot(axis,from),dot(major.xyz,from)/blur,dot(minor.xyz,from));
    direction = vec3(dot(axis,ray),dot(major.xyz,ray)/blur,dot(minor.xyz,ray));
    scale = length(direction);
    direction /= scale;
    along = vec3(1,0,0);
  }
  float depth, exitDepth, alpha;
  if (hard) {
    float pos = hardEntry(start,direction,along,b.w,a.w,flattened,viewInterval.x*scale)/scale;
    if (pos > viewInterval.y || pos >= farRay*.5) return false;
    float exit = -hardEntry(start,-direction,along,b.w,a.w,flattened,-farRay)/scale;
    depth = pos*axial;
    exitDepth = max(pos,min(exit,viewInterval.y))*axial;
    alpha = minor.w;
  } else {
    float offset = dot(start,direction), tilt = dot(along,direction);
    vec3 perpendicular = start-offset*direction, tangent = along-tilt*direction;
    float base = dot(from,ray), slope = dot(axis,ray);
    if (flattened) {
      float sum = 0.0, weighted = 0.0, lateral = dot(major.xyz,ray);
      for (int i=0; i<7; i++) {
        float shift = a.w*circlePoints[i], whitened = shift*4.0;
        vec3 off = vec3(0,whitened,0)-whitened*direction.y*direction;
        vec2 seg = integrated(perpendicular+off,tangent,b.w,a.w,beta);
        float mass = seg.x*circleMass[i];
        sum += mass;
        weighted += mass*(base+shift*lateral+seg.y*slope);
      }
      if (sum <= 0.0) return false;
      depth = weighted/sum;
      alpha = 1.0-exp(-meta.y*sum*(beta ? 35.0/(8.0*sqrt(6.0)) : 1.5957691216)/scale);
    } else {
      vec2 seg = integrated(perpendicular,tangent,b.w,a.w,beta);
      depth = base+seg.y*slope;
      alpha = 1.0-exp(-meta.y*seg.x/scale);
    }
    depth = max(depth,u_curveNear/axial);
    if (depth < viewInterval.x-1e-5 || depth > viewInterval.y) return false;
    depth *= axial;
    exitDepth = depth;
  }
  hit = Hit(id,depth,exitDepth,alpha,meta.x);
  return alpha >= 1e-5;
}`;function Qu({tileSize:e,layers:t,mode:o,wet:s,layeredGlass:i,environment:r,section:c,spriteLOD:l,strandLOD:d,engraving:n,print:u}){let m=o==="owner",p=o==="mask",_=o==="anchors",w=o==="color";return`#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_curveViewport,u_curveInvProjection,u_curveRange;
uniform vec4 u_curveEntry,u_curveCover;
uniform mat4 u_curveView,u_curveProjection;
uniform vec3 u_curveFog;
uniform vec2 u_curveFogRange;
uniform float u_curveNear,u_curveFar,u_curveSetback;
uniform bool u_curveOrtho,u_curveHasProxy,u_filterMatte;
uniform float u_curveArtScale;
uniform highp sampler2D u_curveTiles,u_curveSolid,u_curveProxy;
uniform int u_curveTileColumns;
${m?"uniform sampler2D u_curveOwner,u_curveOwnerMask;":""}
${_?"uniform highp sampler2D u_curveBaseWorld,u_curveBaseRest;":""}
${w&&s?kr(s.airPockets,s.layered,s.atlas):""}
${w&&r?.media?Kt(r.lit):""}
${c??""}
${l??""}
${d??""}
${n?ko(u):""}
layout(location=0) out vec4 o_color;
${p?"":"layout(location=1) out vec4 o_depth;"}
${m||w&&s?"layout(location=2) out vec4 o_aux;":""}
${w&&i?`uniform sampler2D u_curveGlass;
layout(location=${s?3:2}) out vec4 o_back;
layout(location=${s?4:3}) out vec4 o_through;`:""}
${Rp}
${_||n?`
uniform highp sampler2D u_curveMarks;
vec4 curveMark(int id,int field){
  int at=id*6+field;return texelFetch(u_curveMarks,ivec2(at&511,at>>9),0);
}
void curveChart(int id,vec3 at,vec3 ray,out vec3 point,out vec3 localNormal,out vec3 normal,out float stretch){
  vec4 c=curveMark(id,0),a=curveMark(id,1),u=curveMark(id,2),p=curveMark(id,3),t=curveMark(id,4),r=curveMark(id,5);
  vec3 q=at-c.xyz,v=cross(a.xyz,u.xyz),s=cross(t.xyz,r.xyz);
  float along=dot(q,a.xyz),ratio=p.w/max(1e-8,c.w);
  point=p.xyz+t.xyz*(along*ratio)+a.w*(r.xyz*dot(q,u.xyz)+s*dot(q,v));
  vec3 radial=q-a.xyz*clamp(along,-c.w,c.w);
  if(dot(radial,radial)<1e-12)radial=-ray;
  radial=normalize(radial);
  localNormal=normalize(t.xyz*dot(radial,a.xyz)+r.xyz*dot(radial,u.xyz)+s*dot(radial,v));
  normal=transpose(mat3(u_curveView))*radial;
  stretch=max(ratio,a.w)/max(.3,abs(dot(radial,ray)));
}`:""}
vec4 tileRow(int i) { return texelFetch(u_curveTiles,ivec2(i & 511,i >> 9),0); }
float decode(vec3 rgb) { return dot(round(rgb*255.0),vec3(1,256,65536)); }
vec4 encode(float v) { return vec4(mod(v,256.0),mod(floor(v/256.0),256.0),floor(v/65536.0),255.0)/255.0; }
float projectedDepth(float axial) {
  vec4 p = u_curveProjection*vec4(0,0,-axial,1);
  return p.z/p.w*.5+.5;
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 base = texelFetch(u_curveSolid,pixel,0);
  vec2 tile = tileRow((pixel.y/${e})*u_curveTileColumns + pixel.x/${e}).xy;
  ${m?"o_color=texelFetch(u_curveOwner,pixel,0); o_depth=texelFetch(u_curveOwnerMask,pixel,0); o_aux=base;":""}
  ${_?"o_color=texelFetch(u_curveBaseWorld,pixel,0);o_depth=texelFetch(u_curveBaseRest,pixel,0);":""}
  if (tile.y <= 0.0) ${m||_?"return;":"discard;"}
  vec2 film = (gl_FragCoord.xy*2.0/u_curveViewport-1.0)*u_curveInvProjection;
  vec3 origin = u_curveOrtho ? vec3(film,0) : vec3(0);
  vec3 ray = u_curveOrtho ? vec3(0,0,-1) : normalize(vec3(film,-1));
  float opaque = base.a > 0.0 ? mix(u_curveRange.x,u_curveRange.y,decode(base.rgb)/16777215.0) : u_curveFar;
  vec2 interval = vec2(u_curveNear, min(u_curveFar,opaque+1e-4))/(-ray.z);
  if (!clipRay(u_curveEntry,origin,ray,interval) || !clipRay(u_curveCover,origin,ray,interval))
    ${m||_?"return;":"discard;"}
  float proxyDepth = u_curveHasProxy ? texelFetch(u_curveProxy,pixel,0).r : 1.0;
  ${m||p||_?`
  float nearest = opaque+1e-4; int row = -1;
  `:`
  Hit hits[${t}];
  int count = 0;
  ${i?"vec4 glass = texelFetch(u_curveGlass,pixel,0); float pane = decode(glass.rgb)/16777215.0;":""}
  `}
  int start = int(tile.x);
  for (int j=0; j<int(tile.y); j++) {
    int k = start+j;
    int id = int(tileRow(k >> 2)[k & 3]);
    ${l?"if (!spriteGeometry(int(spanRow(id,7).z),gl_FragCoord.xy/u_curveArtScale)) continue;":""}
    ${d?"int strandCode=int(spanRow(id,7).w); if (strandCode!=0 && !strandVisible(strandCode,gl_FragCoord.xy/u_curveArtScale)) continue;":""}
    Hit hit;
    if (!curveHit(id,origin,ray,interval,hit)) continue;
    float projected = projectedDepth(hit.depth);
    if (proxyDepth < 1.0 && projected > proxyDepth+2e-7) continue;
    ${c?`
    vec3 at = origin+ray*(hit.depth/(-ray.z));
    vec3 world = transpose(mat3(u_curveView))*(at-u_curveView[3].xyz);
    if (sectionMargin(world, hit.depth-u_curveSetback) < 0.0) continue;
    `:""}
    ${m||p||_?`
    if (hit.group > 0.0 && hit.alpha >= 1.0 && hit.depth <= nearest) {
      nearest = hit.depth; row = id;
    }`:`
    // Join overlapping hard intervals, but keep distinct crossings of a coiled strand.
    float front = hit.depth, exit = hit.exitDepth;
    if (hit.group > 0.0) {
      for (int i=0; i<count;) {
        Hit previous = hits[i];
        if (previous.group != hit.group || front > previous.exitDepth+1e-6 || previous.depth > exit+1e-6) {
          i++;
          continue;
        }
        if (previous.depth < hit.depth) hit = previous;
        front = min(front,previous.depth);
        exit = max(exit,previous.exitDepth);
        for (int j=i; j<count-1; ++j) hits[j] = hits[j+1];
        count--;
      }
      hit.depth = front; hit.exitDepth = exit;
    }
    // Keep the nearest layers in depth order. Far fragments beyond this budget
    // cannot hide an in-budget crossing.
    int at = count;
    while (at > 0 && hit.depth <= hits[at-1].depth) at--;
    if (at >= ${t}) continue;
    count = min(count+1,${t});
    for (int i=count-1; i>at; --i) hits[i] = hits[i-1];
    hits[at] = hit;
    `}
  }
  ${m?`
  if (row >= 0) {
    o_color = encode(spanRow(row,6).a);
    o_depth = vec4(0);
    o_aux = encode(round(clamp((nearest-u_curveRange.x)/(u_curveRange.y-u_curveRange.x),0.0,1.0)*16777215.0));
  }`:_?`
  if(row>=0){
    vec3 at=origin+ray*(nearest/(-ray.z)), rest, rn,n;float footprint;
    curveChart(row,at,ray,rest,rn,n,footprint);
    o_color=vec4(transpose(mat3(u_curveView))*(at-u_curveView[3].xyz),curveMark(row,2).w);
    o_depth=vec4(rest,1);
  }`:p?`
  if (row < 0) discard;
  o_color=vec4(1);`:`
  if (count == 0) discard;
  o_color=vec4(0); o_depth=vec4(0);
  ${s?"o_aux=vec4(0);":""}
  ${i?"o_back=vec4(0); o_through=vec4(0);":""}
  for (int i=0; i<count; i++) {
    Hit hit = hits[i];
    vec4 pigment = spanRow(hit.row,6);
    float normalized = clamp((hit.depth-u_curveRange.x)/(u_curveRange.y-u_curveRange.x),0.0,1.0);
    vec3 rgb = pigment.rgb;
    ${n?`
    int slot=int(curveMark(hit.row,4).w);
    if(slot>0){
      vec3 at=origin+ray*(hit.depth/(-ray.z)),rest,rn,n;float stretch;
      curveChart(hit.row,at,ray,rest,rn,n,stretch);
      float footprint=2.*u_curveInvProjection.y/u_curveViewport.y*(u_curveOrtho?1.:hit.depth)*stretch;
      rgb=surfaceEngraving(slot,rgb,rest,rn,curveMark(hit.row,4).xyz,n,footprint,u_curveArtScale,0.,vec3(0));
    }`:""}
    if (u_curveFogRange.x < 1.0) rgb = mix(rgb,u_curveFog,smoothstep(u_curveFogRange.x,1.0,normalized)*u_curveFogRange.y);
    ${s?"vec3 mark; rgb = waterPaint(rgb,gl_FragCoord.xy,u_curveViewport,hit.depth,mark);":""}
    ${r?.media?"rgb = envMedia(rgb,gl_FragCoord.xy,u_curveViewport,hit.depth);":""}
    if(u_filterMatte)rgb=vec3(spanRow(hit.row,9).w);
    vec4 ink = vec4(rgb*hit.alpha,hit.alpha);
    float left = 1.0-o_color.a;
    o_color += ink*left;
    ${s?"o_aux += vec4(mark*hit.alpha,hit.alpha)*left;":""}
    ${i?`
    if (glass.a > 0.0 && projectedDepth(hit.depth) > pane+1e-7) o_back += ink*(1.0-o_back.a);
    else if (glass.a > 0.0) o_through.a += hit.alpha*(1.0-o_through.a);
    `:""}
    if (hit.alpha >= 1.0) {
      if (hit.group > 0.0) o_depth=vec4(normalized,0,0,1);
      break;
    }
  }
  `}
}
`}var yi=8,Ap=64,On=512,Ju=40,Sp=1024,Ep=4e6,ir={spans:1,tiles:2,solid:5,proxy:6,owner:7,mask:8,glass:13},ya=[0,0,0,0],el=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],tl=[0,0,0];function gi(e,t){return[0,1,2].map(o=>e[o]*t[0]+e[o+4]*t[1]+e[o+8]*t[2])}function Un(e,t){return gi(e,t).map((o,s)=>o+e[s+12])}function rl(e,t){let o=t.curveMode;if(o!==void 0&&o!=="curves"&&o!=="splats")throw new RangeError("curveMode expects splats or curves");return!!(e.curveSplats&&(o===void 0?t.curveSplats??e.look?.curveSplats??!0:o==="curves"))}function Gn(e,t,o,s,i,r,c){let l=e.curveSplats.renderKernel,{view:d,clipNear:n,ortho:u}=s,m={view:d,near:n,focal:s.projection[5]*r*.5,width:i,height:r,ortho:u},p=c.artScale??1,_=p===1?m:{...m,width:i/p,height:r/p,focal:m.focal/p},w=Math.ceil(i/yi),y=Math.ceil(r/yi),F=Array.from({length:w*y},()=>[]),T=new Uint8Array(t.count),f=[],x=[],E=c.restMarks||c.engraving,{materials:R,materialIds:C}=t.renderMetadata??{},q=(t.anim?.rig||t.anim?.bones||t.reconstructionPose)&&e.splatFrames.create(t,c.time,e.M),g=c.drawOrder&&new Set(c.drawOrder),b=H=>(!c.keep||c.keep(H))&&(!g||g.has(H))&&(!c.visible||c.visible(o[H*16+11])),z=e.curveSplats.subdivision,v=e.curveSplats.strandLod,A=H=>c.engraving?.curve(H)||c.restMarks&&t.curveRest?.[H*16+3],I=c.strandLod&&v.coverageFrame(t,_,{data:o,keep:b,partitionAt:c.geometryCode,forbidden:H=>A(H)||c.strandForbidden?.(H)}),ae=z.prepare(c.curveSubdivision),W=z.frame(t,_,ae,{data:o,planes:c.planes,partitionAt:c.geometryCode,keep:H=>b(H)&&!I?.hidden?.has(H)&&!I?.codes?.has(H)&&!I?.opacity?.has(H)&&!A(H)}),Z=new Map,S=0,k=0,M=!1,K=!1;for(let H=0;H<t.count;H++){let pe=H*16;if(!l.isRow(o,pe)||(T[H]=1,!b(H)||W?.hidden.has(H)||I?.hidden?.has(H)))continue;let de=W?.geometry.get(H),ye=de?.center??Array.from(o.subarray(pe,pe+3)),Y=Math.min(1,I?.opacity?.get(H)??o[pe+3]);if(!(Y>0))continue;let D=o[pe+15],_e=H*l.timingStride,Se=t.curveTiming,Ae=Se?.[_e]&&t.curveTimePrograms?.[Se[_e]-1],B,ie=q&&q(H);if(Ae){if(Z.has(Ae)||Z.set(Ae,Ae.sample(c.time)),B=l.timeWindow(Se,_e,Z.get(Ae),Ae.trail,c.time),!B)continue;Y=l.timedOpacity(Y,B.fade,D),ie&&(B={...B,direction:e.M.app(ie.basis().anchor,B.direction)})}let se=l.clipPlanes(t.curveClips,H,ye,1,ie),ve=l.prepare(de?.data??o,de?0:pe,ye,1,Y,m,se,B);if(!ve)continue;let[j,X,G,Q]=ve.bounds;if(j>=i||G<0||X>=r||Q<0)continue;let be=Math.max(0,Math.floor(j/yi)),ge=Math.min(w-1,Math.floor(G/yi)),le=Math.max(0,Math.floor(X/yi)),Re=Math.min(y-1,Math.floor(Q/yi)),Pe=f.length/Ju;for(let we=le;we<=Re;we++)for(let Fe=be;Fe<=ge;Fe++){let He=F[we*w+Fe];if(He.push(Pe),k=Math.max(k,He.length),++S>Ep||k>Sp)throw new RangeError("Interactive finite curves exceeded the tile budget. Reduce curve density or use curveMode: splats.")}let Ce=(ve.clips??[]).map(({point:we,normal:Fe})=>{let He=gi(d,Fe),it=Un(d,we);return{plane:[...He,-el(He,it)],at:[...it,0]}}),Ee=Number(ve.beta)+2*+!!ve.group+4*+!!ve.major+8*Number(ve.flattened),ke=o[pe+7],he=!t.renderMetadata?.muteEmission?.[H]&&l.emissionAt(t.curveMaterials,H),te=[ke&255,ke>>8&255,ke>>16&255].map((we,Fe)=>Math.min(1,we/255+(he?.[Fe]??0))),ze=c.geometryCode?.(H)??0,me=I?.codes?.get(H)??0;M||=ze!==0,K||=me!==0;let fe=Ce[1]?.at??ya,Me=c.filter?.at(R?.[C?.[H]])??1;if(f.push(...Un(d,ve.from),ve.radius,...gi(d,ve.axis),ve.length,...ve.major?gi(d,ve.major):tl,Ee,...ve.minor?gi(d,ve.minor):tl,ve.opacity,...Ce[0]?.plane??ya,...Ce[1]?.plane??ya,...te,H+1,ve.group,ve.tau,ze,me,...Ce[0]?.at??ya,fe[0],fe[1],fe[2],Me),E){let{V:we}=e,Fe=!de&&t.curveRest?.[pe+3]?t.curveRest.subarray(pe,pe+16):void 0,He=l.spanShape(de?.data??o,de?0:pe,1),it=t.curveStations?.subarray(H*l.stationStride+4,H*l.stationStride+7),rt=!de&&it?.some(Boolean)&&el(it,He.axis)<0?we.mul(He.axis,-1):He.axis,et=Fe?Array.from(Fe.subarray(4,7)):rt,Yt=Fe?Array.from(Fe.subarray(12,15)):ve.major??we.perp(rt),Zt=Fe?Array.from(Fe.subarray(8,11)):Yt;x.push(...Un(d,ye),He.half,...gi(d,rt),(Fe?.[7]??He.radius)/He.radius,...gi(d,Yt),c.restMarks?.slot(H)??0,...Fe?.subarray(0,3)??ye,Fe?.[3]??He.half,...et,c.engraving?.curve(H)??0,...Zt,0)}}let P=F.length*4,L=new Float32Array(P+S),N=P;for(let[H,pe]of F.entries())L[H*4]=N,L[H*4+1]=pe.length,L.set(pe,N),N+=pe.length;return{spans:Float32Array.from(f),tiles:L,columns:w,rows:T,count:f.length/Ju,references:S,peakTile:k,masked:M,strandMasked:K,...E&&{marks:Float32Array.from(x)},...W&&{subdivision:W.stats},...I&&{strandLod:I.stats}}}function il(e,{target:t,table:o,program:s,maxSize:i,textureUnit:r,fullscreen:c,cutaway:l,spriteLOD:d,strandLOD:n,print:u}){let m=o(On,ir.spans,i),p=o(On,ir.tiles,i),_=new Map,w=t(3),y,F;function T(f,x,E,R,C){let{mode:V="color",wet:q,water:g,env:b,layeredGlass:z,glass:v,fog:A,section:I,clip:ae,cover:W,proxy:Z,engraving:S,anchors:k,filterMatte:M,artScale:K=1}=C,P=V==="owner",L=V==="color"&&!!S&&!M,N=[V,!!q,q?.airPockets,q?.layered,q?.atlas,!!b?.media,!!b?.lit,!!I,!!z,f.masked,f.strandMasked,L].join("/");_.has(N)||_.set(N,s(Qu({mode:V,tileSize:yi,layers:Ap,wet:q,layeredGlass:z,environment:b,section:I?l:void 0,spriteLOD:f.masked?d:void 0,strandLOD:f.strandMasked?n:void 0,engraving:L,print:u})));let H=_.get(N),{width:pe,height:de}=E;m.bind(),p.bind(),r(ir.solid,E.textures[2]),r(ir.proxy,Z??E.textures[2]),P&&(r(ir.owner,E.textures[0]),r(ir.mask,E.textures[1])),v&&r(ir.glass,v),L&&S.bind(),k&&(r(10,k.textures[0]),r(11,k.textures[1])),(L||k)&&F.bind(),e.disable(e.DEPTH_TEST),V==="color"?(e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA)):e.disable(e.BLEND),c(H,x.framebuffer,pe,de,{u_curveSpans:ir.spans,u_curveTiles:ir.tiles,u_curveSolid:ir.solid,u_curveProxy:ir.proxy,u_curveOwner:ir.owner,u_curveOwnerMask:ir.mask,u_curveGlass:ir.glass,u_curveViewport:[pe,de],u_curveRange:R.depthRange,u_curveInvProjection:[1/R.projection[0],1/R.projection[5]],u_curveTileColumns:f.columns,u_curveEntry:ae,u_curveCover:W??ya,u_curveView:R.view,u_curveProjection:R.projection,u_curveNear:R.clipNear,u_curveFar:R.clipFar,u_curveSetback:R.setback,u_curveOrtho:R.ortho,u_curveHasProxy:!!Z,u_curveArtScale:K,u_filterMatte:!!M,u_curveFog:A.color,u_curveFogRange:A.range,u_curveMarks:12,u_curveBaseWorld:10,u_curveBaseRest:11,...g,...b?.uniforms,...I,...L&&S.uniforms}),e.disable(e.BLEND)}return{prepare(f){f.marks&&(F??=o(On,12,i),F.upload(f.marks)),m.upload(f.spans),p.upload(f.tiles)},draw:T,anchors(f,x,E,R,C){return y??=t(2,{floating:!0}),y.resize(x.width,x.height),T(f,y,x,E,{...R,mode:"anchors",anchors:C}),y},owner(f,x,E,R){return w.resize(x.width,x.height),T(f,w,x,E,{...R,mode:"owner"}),w}}}var To=Symbol("rendered camera");function Ro(e,t){return{[To](o){t(o),e[To]?.(o)}}}var Ui=`
vec4 layerTexel(sampler2D image, ivec2 pos, ivec2 size, bool topDown) {
  if (!topDown) pos.y = size.y - 1 - pos.y;
  return texelFetch(image, pos, 0);
}

vec4 layerRegionAt(sampler2D image, vec2 pixel, vec2 outputSize, ivec4 region, bool topDown, bool linear) {
  ivec2 size = region.zw, origin = region.xy, full = textureSize(image, 0);
  vec2 uv = pixel * vec2(size) / outputSize;
  if (!linear) return layerTexel(image, origin + clamp(ivec2(uv), ivec2(0), size - 1), full, topDown);
  vec2 pos = clamp(uv - 0.5, vec2(0.0), vec2(size) - 1.0);
  ivec2 p = ivec2(pos), q = min(p + 1, size - 1);
  vec2 f = fract(pos);
  return mix(mix(layerTexel(image, origin + p, full, topDown), layerTexel(image, origin + ivec2(q.x, p.y), full, topDown), f.x),
    mix(layerTexel(image, origin + ivec2(p.x, q.y), full, topDown), layerTexel(image, origin + q, full, topDown), f.x), f.y);
}

vec4 layerAt(sampler2D image, vec2 pixel, vec2 outputSize, bool topDown, bool linear) {
  return layerRegionAt(image, pixel, outputSize, ivec4(ivec2(0), textureSize(image, 0)), topDown, linear);
}

vec4 placedLayerAt(sampler2D image, vec2 pixel, vec4 dest, ivec4 region, bool topDown, bool linear) {
  vec2 position = pixel - dest.xy;
  if (any(lessThan(position, vec2(0.0))) || any(greaterThanEqual(position, dest.zw))) return vec4(0.0);
  return layerRegionAt(image, position, dest.zw, region, topDown, linear);
}
`,Fp=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_layer;
uniform vec2 u_outputSize;
uniform vec4 u_dest;
uniform ivec4 u_region;
uniform bool u_topDown, u_linear, u_opaque;
uniform float u_opacity;
out vec4 color;

${Ui}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, u_outputSize.y - gl_FragCoord.y);
  color = placedLayerAt(u_layer, pixel, u_dest, u_region, u_topDown, u_linear);
  if (u_opaque) color.a = 1.0;
  color *= u_opacity;
}`;function al(e,{program:t,resources:o,target:s,textureUnit:i,fullscreen:r}){let c=t(Fp),l=s(),d=o.texture(),n=0,u=0;return function(p,_,w,y,F,T){let{w:f,h:x}=w;l.resize(w.world.w,w.world.h),T(p,_,w.world.w,w.world.h,l.framebuffer);let E=typeof y=="function"?y():y;if(F||(e.canvas.width!==f&&(e.canvas.width=f),e.canvas.height!==x&&(e.canvas.height=x)),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE),e.disable(e.STENCIL_TEST),e.disable(e.SCISSOR_TEST),e.disable(e.BLEND),e.colorMask(!0,!0,!0,!0),i(0,l.textures[0]),r(c,F,f,x,{u_layer:0,u_outputSize:[f,x],u_topDown:!1,u_opaque:!0,u_dest:[0,0,f,x],u_region:[0,0,l.width,l.height],u_linear:w.world.filter==="linear",u_opacity:1}),E.length){e.enable(e.BLEND),e.blendEquation(e.FUNC_ADD);for(let R of E)R.gpu?i(0,R.gpu.texture):(i(0,d),n!==R.w||u!==R.h?(e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,R.w,R.h,0,e.RGBA,e.UNSIGNED_BYTE,R.data),n=R.w,u=R.h):e.texSubImage2D(e.TEXTURE_2D,0,0,0,R.w,R.h,e.RGBA,e.UNSIGNED_BYTE,R.data)),e.blendFuncSeparate(e.ONE,R.blend==="add"?e.ONE:e.ONE_MINUS_SRC_ALPHA,e.ONE,e.ONE_MINUS_SRC_ALPHA),r(c,F,f,x,{u_topDown:!R.gpu,u_opaque:!1,u_dest:R.dest,u_region:R.gpu?.region??[0,0,R.w,R.h],u_linear:R.filter==="linear",u_opacity:R.opacity});e.disable(e.BLEND)}}}var ol=`
precision highp float;
precision highp int;
uniform sampler2D u_input, u_mask, u_owner, u_selected, u_depth, u_groups, u_work;
uniform vec2 u_size, u_workSize, u_depthRange;
uniform bool u_packedDepth, u_hasMask, u_hasSelect, u_hasDepth, u_hasGroups, u_depthMask, u_depthInvert, u_background, u_protect, u_sourceMask, u_outputMask, u_linear;
uniform vec3 u_depthWindow, u_tint;
uniform int u_kind, u_samples, u_side, u_span;
uniform float u_depthThreshold, u_opacity, u_radius, u_threshold, u_intensity, u_inner, u_width, u_relativeDepth;
uniform vec2 u_offset, u_center, u_blockSize, u_sortThreshold;
uniform float u_radial, u_probability;
uniform uint u_seed, u_tick;
uniform bool u_horizontal, u_descending;
${Ui}
vec4 readAt(vec2 p){return layerAt(u_input,p,u_size,false,false);}
bool inside(vec2 p){return all(greaterThanEqual(p,vec2(0.0)))&&all(lessThan(p,u_size));}
float zAt(vec2 p){
  if(!u_hasDepth)return 1e20;
  vec4 value=layerAt(u_depth,p,u_size,false,false);
  float n=u_packedDepth?(value.a<.5?1.0:dot(round(value.rgb*255.0),vec3(1.0,256.0,65536.0))/16777215.0):value.r;
  return n>=1.0?1e20:mix(u_depthRange.x,u_depthRange.y,n);
}
int ownerAt(vec2 p){
  ivec3 bytes=ivec3(floor(layerAt(u_owner,p,u_size,false,false).rgb*255.0+.5));
  return bytes.r+bytes.g*256+bytes.b*65536;
}
vec4 groupAt(vec2 p){
  if(!u_hasGroups)return vec4(0.0);
  int id=ownerAt(p),width=textureSize(u_groups,0).x;
  return texelFetch(u_groups,ivec2(id%width,id/width),0);
}
float weightAt(vec2 p){
  float weight=u_hasMask?layerAt(u_mask,p,u_size,false,false).r:1.0;
  if(u_hasSelect){int id=ownerAt(p),width=textureSize(u_selected,0).x;weight*=texelFetch(u_selected,ivec2(id%width,id/width),0).r;}
  if(u_depthMask){
    float z=zAt(p),edge=min(z-u_depthWindow.x,u_depthWindow.y-z);
    float a=u_depthWindow.z>0.0?clamp(edge/u_depthWindow.z,0.0,1.0):step(0.0,edge);
    weight*=z>1e19?(u_background?1.0:0.0):(u_depthInvert?1.0-a:a);
  }
  return weight;
}
bool compatible(vec2 p,vec2 q,bool emission){
  if(!inside(q))return false;
  float a=zAt(p),b=zAt(q);bool skyA=a>1e19,skyB=b>1e19;
  if(emission)return skyA||(!skyB&&b<=a+u_depthThreshold);
  return skyA==skyB&&(skyA||abs(a-b)<=u_depthThreshold)&&(!u_protect||groupAt(p)==groupAt(q));
}
float luminance(vec4 c){return dot(c.rgb,vec3(.2126,.7152,.0722))/max(1e-9,c.a);}
vec3 linearRGB(vec3 c){return mix(pow((c+.055)/1.055,vec3(2.4)),c/12.92,lessThanEqual(c,vec3(.04045)));}
vec3 displayRGB(vec3 c){return mix(1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-.055,c*12.92,lessThanEqual(c,vec3(.0031308)));}
uint hash(uint x){x=(x^(x>>16))*0x7feb352du;x=(x^(x>>15))*0x846ca68bu;return x^(x>>16);}
vec2 sortAt(int n,vec2 p){return u_horizontal?vec2((float(n)+.5)*u_size.x/u_workSize.x,p.y):vec2(p.x,(float(n)+.5)*u_size.y/u_workSize.y);}
bool eligible(vec2 p,vec2 q){
  if(!compatible(q,p,false)||(u_sourceMask&&weightAt(p)<=0.0))return false;
  vec4 c=readAt(p);float l=luminance(c);
  return c.a>0.0&&l>=u_sortThreshold.x&&l<=u_sortThreshold.y;
}
`,zp=`#version 300 es
${ol}
out vec4 color;
void main(){
  vec2 site=vec2(gl_FragCoord.x,u_workSize.y-gl_FragCoord.y),p=site*u_size/u_workSize;
  vec4 base=readAt(p),result=base;
  if(u_kind==8||u_kind==9){
    vec3 sum=vec3(0.0);
    for(int k=0;k<64;k++){
      if(k>=u_samples)break;
      float t=(float(k)+.5)/float(u_samples),r=u_radius*sqrt(u_kind==9?u_inner*u_inner+t*(1.0-u_inner*u_inner):t),a=float(k)*2.39996323;
      vec2 q=p+r*vec2(cos(a),sin(a));
      if(!compatible(p,q,true))continue;
      vec4 c=readAt(q);float bright=max(c.r,max(c.g,c.b))/max(c.a,1e-9);
      float amount=clamp((bright-u_threshold)/(1.0-u_threshold),0.0,1.0)*(u_sourceMask?weightAt(q):1.0)*(u_kind==8?exp(-2.0*t):1.0);
      sum+=linearRGB(c.rgb/max(c.a,1e-9))*c.a*amount*u_tint/float(u_samples);
    }
    color=vec4(sum*u_intensity*(u_kind==8?2.35:1.0),1.0);return;
  }
  if(u_kind==10){
    float z=zAt(p),coverage=0.0;vec4 g=groupAt(p);
    for(int k=0;k<8;k++){
      if(k>=u_samples)break;float a=float(k)*6.28318530718/float(u_samples);vec2 q=p+u_width*vec2(cos(a),sin(a));if(!inside(q))continue;
      float nz=zAt(q);vec4 ng=groupAt(q);bool near=z<nz,far=nz<z,sky=z>1e19,nsky=nz>1e19;
      bool boundary=sky!=nsky||!sky&&!nsky&&abs(z-nz)>max(u_depthThreshold,min(z,nz)*u_relativeDepth)||u_protect&&g!=ng;
      if(!boundary)continue;
      if(u_side!=1&&!sky&&(near||g!=ng&&!far))coverage=max(coverage,u_sourceMask?weightAt(p):1.0);
      if(u_side!=0&&!nsky&&(far||g!=ng&&!near))coverage=max(coverage,u_sourceMask?weightAt(q):1.0);
    }
    color=vec4(u_tint,coverage);return;
  }
  if(u_kind==11){
    vec2 offset=u_offset+(p/u_size-u_center)*u_radial;
    if(compatible(p,p+offset,false)&&(!u_sourceMask||weightAt(p+offset)>0.0))result.r=readAt(p+offset).r;
    if(compatible(p,p-offset,false)&&(!u_sourceMask||weightAt(p-offset)>0.0))result.b=readAt(p-offset).b;
  }else if(u_kind==12){
    uvec2 block=uvec2(floor(p/u_blockSize));
    uint key=hash(block.x*73856093u^block.y*19349663u^u_tick*83492791u^u_seed);
    if(float(key>>8u)/16777216.0<u_probability){
      vec2 q=p+u_offset*((key&1u)==1u?1.0:-1.0);
      if(compatible(p,q,false)&&(!u_sourceMask||weightAt(q)>0.0))result=readAt(q);
    }
  }else if(u_kind==13){
    int center=int(u_horizontal?site.x:site.y),extent=int(u_horizontal?u_workSize.x:u_workSize.y),start=center/u_span*u_span;
    if(eligible(p,p)){
      int left=center,right=center;
      for(int k=0;k<32;k++){if(left<=start||!eligible(sortAt(left-1,p),sortAt(left,p)))break;left--;}
      for(int k=0;k<32;k++){if(right+1>=min(start+u_span,extent)||!eligible(sortAt(right+1,p),sortAt(right,p)))break;right++;}
      // Bounded insertion sort. Each bucket is <=32 working cells; the resource
      // plan charges its quadratic comparison cost as well as source samples.
      vec4 values[32];int count=right-left+1;
      for(int k=0;k<32;k++){
        if(k>=count)break;
        vec4 value=readAt(sortAt(left+k,p));int dest=k;
        for(int j=0;j<32;j++){
          if(dest<=0)break;
          float d=(luminance(values[dest-1])-luminance(value))*(u_descending?-1.0:1.0);
          if(d<=0.0)break;values[dest]=values[dest-1];dest--;
        }
        values[dest]=value;
      }
      result=values[center-left];
    }
  }
  float gate=u_sourceMask?weightAt(p):1.0;
  color=vec4((vec3(128.0)+(result.rgb-base.rgb)*gate*127.0)/255.0,1.0);
}`,Mp=`#version 300 es
${ol}
out vec4 color;
void main(){
  vec2 p=vec2(gl_FragCoord.x,u_size.y-gl_FragCoord.y);vec4 base=readAt(p);color=base;
  float amount=u_opacity*(u_outputMask?weightAt(p):1.0);if(amount<=0.0)return;
  vec2 uv=p*u_workSize/u_size-.5,origin=floor(uv),fraction=fract(uv);
  vec4 sum=vec4(0.0);float norm=0.0;bool glow=u_kind==8||u_kind==9;
  for(int k=0;k<4;k++){
    if(!u_linear&&k>0)break;
    vec2 index=clamp(u_linear?origin+vec2(k%2,k/2):floor(uv+.5),vec2(0.0),u_workSize-1.0);
    vec2 q=(index+.5)*u_size/u_workSize;
    if(!compatible(p,q,glow||u_kind==10&&u_side!=0))continue;
    float a=u_linear?(k%2==1?fraction.x:1.0-fraction.x)*(k>=2?fraction.y:1.0-fraction.y):1.0;
    sum+=layerAt(u_work,index+.5,u_workSize,false,false)*a;norm+=a;
  }
  if(norm<=0.0)return;sum/=norm;
  if(glow)color.rgb=displayRGB(linearRGB(base.rgb/max(base.a,1e-9))+sum.rgb*amount)*base.a;
  else if(u_kind==10)color.rgb=mix(base.rgb,sum.rgb*base.a,sum.a*amount);
  else color.rgb=base.rgb+(sum.rgb*255.0-128.0)/127.0*amount;
  color.rgb=clamp(color.rgb,vec3(0.0),vec3(base.a));
}`;function nl(e,{program:t,target:o,textureUnit:s,fullscreen:i}){let r,c,l;return function(n,u,m,p,_,w,y,F){r??=t(zp),c??=t(Mp),e.activeTexture(e.TEXTURE10),l??=o(),l.resize(u.width,u.height),s(0,F),s(10,l.textures[0]);let T={...p,u_work:10,u_groups:9,u_workSize:[u.width,u.height],u_kind:n.operation,u_sourceMask:n.maskMode!=="output",u_outputMask:n.maskMode!=="source",u_protect:n.protectObjects,u_linear:n.budget.filter==="linear",u_samples:u.samples,u_tint:(n.tint??n.color??[255,255,255]).map(f=>f/255),u_radius:n.radius??1,u_threshold:Array.isArray(n.threshold)?0:n.threshold??0,u_intensity:n.intensity??1,u_inner:n.inner??0,u_width:n.width??1,u_relativeDepth:n.relativeDepth??0,u_side:["inner","outer","both"].indexOf(n.side),u_offset:n.offset??[0,0],u_center:n.center??[.5,.5],u_radial:n.radial??0,u_blockSize:n.blockSize??[1,1],u_probability:n.probability??0,u_seed:n.seed??1,u_tick:Math.floor(y*(n.rate??0))>>>0,u_span:Math.min(n.span??2,u.samples),u_sortThreshold:Array.isArray(n.threshold)?n.threshold:[0,1],u_horizontal:n.axis!=="y",u_descending:n.descending??!1};i(r,l.framebuffer,u.width,u.height,T),i(c,m.framebuffer,_,w,T)}}var $n=Symbol("render graph raster capture"),ri=Symbol("render graph owner capture"),cl=`
bool tileDue(vec2 pixel, ivec3 tiles, ivec4 cycle) {
  if (cycle.w <= 0) return false;
  ivec2 tile = ivec2(pixel) / tiles.xy;
  int index = tile.y * tiles.z + tile.x, period = cycle.x;
  int offset = ((index % period) * cycle.y) % period;
  return (cycle.z + period - offset) % period < cycle.w;
}
`;function sl(e,t){return e?{cycle:[e.every,e.step,(e.head-e.phase+e.every)%e.every,e.span],tiles:[...e.size,Math.ceil(t/e.size[0])]}:{cycle:[1,0,0,0],tiles:[1,1,1]}}var Cp=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_input, u_mask, u_owner, u_selected, u_depth, u_history, u_auxMask;
uniform highp sampler2D u_source;
uniform highp sampler2D u_rows, u_schedulePalette;
uniform bool u_scheduleIndexed, u_addressLinear;
uniform ivec2 u_addressEdges;
uniform vec4 u_windowCrop, u_windowDest, u_windowLine, u_windowInk;
uniform float u_windowBorder, u_windowLeader;
uniform bool u_windowLinear, u_windowHasSourceMask;
uniform highp sampler3D u_cube;
uniform vec2 u_size, u_passSize, u_offset, u_amplitude;
uniform bool u_packedDepth, u_depthMask, u_depthInvert, u_background, u_displayMask, u_budgetLinear;
uniform vec3 u_depthWindow;
uniform int u_operation;
uniform bool u_hasMask, u_hasSelect, u_hasRect, u_invert, u_layer, u_linear, u_add, u_enabled;
uniform float u_opacity, u_feather, u_line, u_frequency, u_phase, u_cubeSize;
uniform bool u_reflectX;
uniform vec4 u_rect, u_layerDest;
uniform ivec4 u_layerRegion;
uniform bool u_layerTopDown;
uniform vec3 u_volumeAt, u_extent, u_eye;
uniform vec2 u_depthRange, u_projectionScale;
uniform mat4 u_view;
uniform bool u_volume, u_ortho, u_captureHistory, u_hasHistory, u_hold, u_hasAuxMask, u_hasFlow;
uniform float u_volumeFeather, u_decay;
uniform vec2 u_feedbackPivot, u_feedbackTransform, u_threshold;
uniform float u_blockSize, u_gain;
uniform bool u_feedbackLinear, u_hasThreshold;
uniform bool u_scanlines, u_rejectDepth, u_hasDepth, u_isolated, u_over, u_wrap;
uniform bool u_rawMotion, u_motionPerFrame, u_needsRawMotion, u_blockMemory, u_hasBlockHold;
uniform sampler2D u_blockHold;
uniform vec4 u_blockRect;
uniform ivec4 u_blockCycle;
uniform ivec3 u_blockTiles;
uniform float u_depthThreshold;
uniform vec2 u_flowScale, u_flowVelocity, u_flowBlock;
uniform float u_smearElapsed;
out vec4 color;

${Ui}
${cl}

float depthAt(vec2 pixel) {
  ivec2 size = textureSize(u_depth, 0);
  ivec2 site = min(ivec2(pixel / u_size * vec2(size)), size - 1);
  vec4 value=texelFetch(u_depth, ivec2(site.x, size.y - 1 - site.y), 0);
  return u_packedDepth ? (value.a<.5 ? 1.0 : dot(round(value.rgb*255.0),vec3(1.0,256.0,65536.0))/16777215.0) : value.r;
}

int addressAxis(int n, int size, int edge) {
  if (edge == 0) return clamp(n, 0, size - 1);
  if (edge == 1) return n >= 0 && n < size ? n : -1;
  int span = edge == 3 ? size * 2 : size;
  int at = n - (n / span) * span;
  if (at < 0) at += span;
  return at < size ? at : span - 1 - at;
}

vec4 addressedColor(ivec2 site, ivec2 size) {
  int x = addressAxis(site.x, size.x, u_addressEdges.x);
  int y = addressAxis(site.y, size.y, u_addressEdges.y);
  return x < 0 || y < 0 ? vec4(0.0) : texelFetch(u_source, ivec2(x, size.y - 1 - y), 0);
}

vec4 textureAddress(vec2 uv) {
  ivec2 size = textureSize(u_source, 0);
  vec2 at = uv * vec2(size);
  if (!u_addressLinear) return addressedColor(ivec2(floor(at)), size);
  at -= .5;
  ivec2 p = ivec2(floor(at));
  vec2 f = fract(at);
  return mix(mix(addressedColor(p, size), addressedColor(p + ivec2(1, 0), size), f.x),
    mix(addressedColor(p + ivec2(0, 1), size), addressedColor(p + ivec2(1), size), f.x), f.y);
}

vec4 windowTap(ivec2 site, ivec2 size) {
  site = clamp(site, ivec2(0), size - 1);
  site.y = size.y - 1 - site.y;
  vec4 sampleColor = texelFetch(u_source, site, 0);
  return u_windowHasSourceMask ? sampleColor * texelFetch(u_auxMask, site, 0).r : sampleColor;
}

vec4 windowPixel(vec2 pixel) {
  vec2 local = pixel - u_windowDest.xy;
  if (all(greaterThanEqual(local, vec2(0.0))) && all(lessThan(local, u_windowDest.zw))) {
    vec2 edges = min(local, u_windowDest.zw - local);
    if (min(edges.x, edges.y) < u_windowBorder) return u_windowInk;
    ivec2 size = textureSize(u_source, 0);
    if (!u_windowLinear) {
      if (any(lessThanEqual(u_windowCrop.xy + u_windowCrop.zw, vec2(0.0))) ||
          any(greaterThanEqual(u_windowCrop.xy, vec2(size)))) return vec4(0.0);
      ivec2 donor = ivec2(u_windowCrop.xy) + (2 * ivec2(local) + 1) * ivec2(u_windowCrop.zw) / (2 * ivec2(u_windowDest.zw));
      return any(lessThan(donor, ivec2(0))) || any(greaterThanEqual(donor, size)) ? vec4(0.0) : windowTap(donor, size);
    }
    vec2 at = u_windowCrop.xy + local * u_windowCrop.zw / u_windowDest.zw;
    if (any(lessThan(at, vec2(0.0))) || any(greaterThanEqual(at, vec2(size)))) return vec4(0.0);
    at -= .5;
    ivec2 p = ivec2(floor(at));
    vec2 f = fract(at);
    return mix(mix(windowTap(p, size), windowTap(p + ivec2(1, 0), size), f.x),
      mix(windowTap(p + ivec2(0, 1), size), windowTap(p + ivec2(1), size), f.x), f.y);
  }
  if (u_windowLeader > 0.0) {
    vec2 line = u_windowLine.zw - u_windowLine.xy;
    vec2 from = pixel - u_windowLine.xy;
    vec2 delta = from - line * clamp(dot(from, line) / dot(line, line), 0.0, 1.0);
    if (dot(delta, delta) <= u_windowLeader * u_windowLeader * .25) return u_windowInk;
  }
  return vec4(0.0);
}

void main() {
  ivec2 pos = ivec2(gl_FragCoord.xy);
  vec2 pixel = vec2(gl_FragCoord.x, u_passSize.y - gl_FragCoord.y) * u_size / u_passSize;
  vec4 inputColor = layerAt(u_input, pixel, u_size, false, false);
  if (u_operation == 0) { color = inputColor; return; }
  if (u_isolated) inputColor = vec4(0.0);
  float weight = u_hasMask ? layerAt(u_mask, pixel, u_size, false, false).r : 1.0;
  float chosen = 1.0;
  if (u_hasSelect) {
    vec3 encoded = layerAt(u_owner, pixel, u_size, false, false).rgb;
    ivec3 bytes = ivec3(floor(encoded * 255.0 + 0.5));
    int id = bytes.r + bytes.g * 256 + bytes.b * 65536;
    int rowWidth = textureSize(u_selected, 0).x;
    chosen = texelFetch(u_selected, ivec2(id % rowWidth, id / rowWidth), 0).r;
    weight *= chosen;
  }
  if (u_depthMask) {
    float n = u_hasDepth ? depthAt(pixel) : 1.0;
    float z = mix(u_depthRange.x, u_depthRange.y, n);
    float edge = min(z - u_depthWindow.x, u_depthWindow.y - z);
    float a = u_depthWindow.z > 0.0 ? clamp(edge / u_depthWindow.z, 0.0, 1.0) : step(0.0, edge);
    weight *= n >= 1.0 ? (u_background ? 1.0 : 0.0) : (u_depthInvert ? 1.0 - a : a);
  }
  if (u_operation == 1) {
    if (u_layer) weight *= placedLayerAt(u_source, pixel, u_layerDest, u_layerRegion, u_layerTopDown, u_linear).a;
    if (u_volume) {
      ivec2 size = textureSize(u_depth, 0);
      ivec2 site = min(ivec2(pixel / u_size * vec2(size)), size - 1);
      float norm = depthAt(pixel);
      if (norm >= 1.0) weight = 0.0;
      else {
        float depth = mix(u_depthRange.x, u_depthRange.y, norm);
        vec2 uv = (vec2(site) + .5) / vec2(size);
        vec2 plane = (uv * vec2(2.0, -2.0) + vec2(-1.0, 1.0)) * u_projectionScale;
        vec3 local = vec3(plane * (u_ortho ? 1.0 : depth), -depth);
        vec3 position = u_eye + vec3(dot(u_view[0].xyz, local), dot(u_view[1].xyz, local), dot(u_view[2].xyz, local));
        float d = length((position - u_volumeAt) / u_extent);
        weight *= u_volumeFeather > 0.0 ? clamp((1.0 - d) / u_volumeFeather, 0.0, 1.0) : step(d, 1.0);
      }
    }
    if (u_hasRect) {
      vec2 edges = min(pixel - u_rect.xy, u_rect.xy + u_rect.zw - pixel);
      float edge = min(edges.x, edges.y);
      weight *= u_feather > 0.0 ? clamp(edge / u_feather, 0.0, 1.0) : step(0.0, edge);
    }
    color = vec4(u_enabled ? (u_invert ? 1.0 - weight : weight) * u_opacity : 0.0);
    return;
  }
  if (u_operation == 17) {
    ivec2 site = ivec2(pixel), size = ivec2(u_size);
    ivec4 row = ivec4(texelFetch(u_rows, ivec2(0, site.y), 0));
    ivec2 state = ivec2(texelFetch(u_rows, ivec2(1, site.y), 0).xy);
    ivec2 local = site - ivec2(0, state.x);
    ivec2 donor = (local / row.zw) * row.zw + ivec2(0, state.x) + row.xy;
    if (u_wrap) donor = ivec2(mod(vec2(donor), u_size));
    vec4 scheduled = vec4(0.0);
    if (all(greaterThanEqual(donor, ivec2(0))) && all(lessThan(donor, size))) {
      ivec2 extent = textureSize(u_source, 0);
      ivec2 at = ((2 * donor + 1) * extent) / (2 * size);
      if (!u_scheduleIndexed) at.y = extent.y - 1 - at.y;
      scheduled = texelFetch(u_source, at, 0);
      if (u_scheduleIndexed) {
        int slot = int(floor(scheduled.r * 255.0 + 0.5));
        int coverage = int(floor(scheduled.a * 255.0 + 0.5));
        ivec4 swatch = ivec4(floor(texelFetch(u_schedulePalette, ivec2(slot, state.y), 0) * 255.0 + 0.5));
        int alpha = (coverage * swatch.a + 127) / 255;
        scheduled = vec4(vec3((swatch.rgb * alpha + 127) / 255), float(alpha)) / 255.0;
      }
    }
    weight *= u_opacity;
    if (u_over) {
      scheduled *= weight;
      color = scheduled + inputColor * (1.0 - scheduled.a);
    } else color = mix(inputColor, scheduled, weight);
    color = floor(color * 255.0 + .50001) / 255.0;
    return;
  }
  if (u_operation == 18) {
    vec3 uv = texelFetch(u_rows, ivec2(pixel), 0).rgb;
    vec4 addressed = uv.z > 0.0 ? textureAddress(uv.xy) * uv.z : vec4(0.0);
    weight *= u_opacity;
    if (u_over) {
      addressed *= weight;
      color = addressed + inputColor * (1.0 - addressed.a);
    } else color = mix(inputColor, addressed, weight);
    color = floor(color * 255.0 + .50001) / 255.0;
    return;
  }
  if (u_operation == 6) {
    vec4 previous = u_hasHistory ? layerAt(u_history, pixel, u_size, false, u_budgetLinear) : vec4(0.0);
    if (u_captureHistory) {
      vec4 fresh = inputColor * weight;
      color = u_hold && previous.a > 0.0 ? previous :
        min(vec4(1.0), fresh + floor(previous * u_decay * (1.0 - fresh.a) * 255.0 + .00001) / 255.0);
    } else {
      vec4 sampleColor = previous * (chosen * u_opacity);
      color = sampleColor + inputColor * (1.0 - sampleColor.a);
    }
    return;
  }
  if (u_operation == 7) {
    if (u_captureHistory) {
      vec4 previous = vec4(0.0);
      if (u_hasHistory) {
        vec2 local = pixel - u_feedbackPivot;
        float c = u_feedbackTransform.x, s = u_feedbackTransform.y;
        vec2 field = u_blockSize > 0.0 ? (floor(pixel / u_blockSize) + .5) * u_blockSize : pixel;
        vec2 sampleAt = u_feedbackPivot + vec2(c * local.x + s * local.y, -s * local.x + c * local.y)
          - u_offset - u_amplitude * sin(field.yx * u_frequency + u_phase);
        if (all(greaterThanEqual(sampleAt, vec2(0.0))) && all(lessThan(sampleAt, u_size)))
          previous = layerAt(u_history, sampleAt, u_size, false, u_feedbackLinear);
      }
      vec4 fresh = u_layer ? placedLayerAt(u_source, pixel, u_layerDest, u_layerRegion, u_layerTopDown, u_linear)
        : layerAt(u_source, pixel, u_size, false, false);
      float gain = weight * u_gain;
      if (u_hasThreshold && fresh.a > 0.0) {
        float amount = max(fresh.r, max(fresh.g, fresh.b)) / fresh.a;
        gain *= clamp((amount - u_threshold.x) / (u_threshold.y - u_threshold.x), 0.0, 1.0);
      }
      fresh *= gain;
      color = min(vec4(1.0), fresh + floor(previous * u_decay * (1.0 - fresh.a) * 255.0 + .00001) / 255.0);
    } else {
      vec4 signal = layerAt(u_history, pixel, u_size, false, u_budgetLinear) * u_opacity * (u_displayMask ? weight : 1.0);
      color.a = signal.a + inputColor.a * (1.0 - signal.a);
      color.rgb = min(vec3(color.a), signal.rgb + inputColor.rgb * (u_add ? 1.0 : 1.0 - signal.a));
    }
    return;
  }
  if (u_operation == 14) {
    if (u_captureHistory) {
      color = inputColor * chosen;
    } else {
      vec4 donor = layerAt(u_history, pixel, u_size, false, u_budgetLinear);
      if (u_hasAuxMask) weight *= layerAt(u_auxMask, pixel, u_size, false, false).r;
      color = u_hasSelect && donor.a <= 0.0 ? inputColor : mix(inputColor, donor, weight * u_opacity);
    }
    return;
  }
  if (u_operation == 15) {
    color = inputColor;
    if (!u_hasHistory) return;
    vec2 origin = u_blockMemory ? u_blockRect.xy : vec2(0.0);
    vec2 edge = u_blockMemory ? u_blockRect.zw : u_size;
    if (any(lessThan(pixel, origin)) || any(greaterThanEqual(pixel, edge))) return;
    if (u_blockMemory && tileDue(pixel - origin, u_blockTiles, u_blockCycle)) return;
    vec2 block = origin + floor((pixel - origin) / u_flowBlock) * u_flowBlock;
    vec2 center = block + min(u_flowBlock, edge - block) * .5;
    vec2 maskPixel = u_blockMemory ? center : pixel;
    float keep = u_hasAuxMask ? 1.0 - layerAt(u_auxMask, maskPixel, u_size, false, false).r : 1.0;
    if (keep <= 0.0) return;
    bool held = u_blockMemory && u_hasBlockHold && layerAt(u_blockHold, center, u_size, false, false).r > .5;
    float amount = keep;
    vec2 donor = pixel;
    if (!held) {
      if (u_decay <= 0.0 || (u_needsRawMotion && !u_hasFlow)) return;
      vec2 offset = u_flowVelocity * u_smearElapsed;
      amount *= u_decay;
      if (u_hasFlow) {
        vec4 flow = layerAt(u_source, center, u_size, u_rawMotion, false);
        if (flow.a <= 0.0 || flow.b <= 0.0) return;
        if (u_rawMotion) {
          offset += flow.rg * u_flowScale * (u_motionPerFrame ? 1.0 : u_smearElapsed);
        } else {
          vec2 bytes = floor(flow.rg / flow.a * 255.0 + .5);
          vec2 velocity = u_flowVelocity + max(vec2(-1.0), (bytes - 128.0) / 127.0) * u_flowScale;
          offset = velocity * u_smearElapsed;
        }
        amount *= flow.b;
      }
      donor -= offset;
      if (any(lessThan(donor, origin)) || any(greaterThanEqual(donor, edge))) return;
    }
    vec2 site = u_captureHistory ? donor : pixel;
    if (u_blockMemory) {
      vec2 scale = vec2(textureSize(u_history, 0)) / u_size;
      vec2 first = ceil(origin * scale - .5) + .5;
      vec2 last = ceil(edge * scale - .5) - .5;
      if (any(greaterThan(first, last))) return;
      site = clamp(site * scale, first, last) / scale;
    }
    vec4 old = layerAt(u_history, site, u_size, false, u_budgetLinear);
    if (u_captureHistory) {
      vec4 delta = (old - inputColor) * (amount * 255.0);
      color = inputColor + sign(delta) * floor(abs(delta) + .00001) / 255.0;
    } else color = floor(mix(inputColor, old, weight * u_opacity) * 255.0 + .50001) / 255.0;
    return;
  }
  if (u_operation == 16) {
    vec4 bank = layerAt(u_history, pixel, u_size, false, u_budgetLinear);
    color = floor(mix(inputColor, bank, weight * u_opacity) * 255.0 + .50001) / 255.0;
    return;
  }
  weight *= u_opacity;
  color = inputColor;
  if (weight <= 0.0) return;
  if (u_operation == 19) {
    vec2 center = vec2(pos.x, int(u_passSize.y) - 1 - pos.y) + .5;
    vec4 overlay = windowPixel(center) * weight;
    color = floor((overlay + inputColor * (1.0 - overlay.a)) * 255.0 + .50001) / 255.0;
  } else if (u_operation == 2) {
    if (inputColor.a <= 0.0) return;
    vec3 lookup = (clamp(inputColor.rgb / inputColor.a, 0.0, 1.0) * (u_cubeSize - 1.0) + 0.5) / u_cubeSize;
    color.rgb = mix(inputColor.rgb, texture(u_cube, lookup).rgb * inputColor.a, weight);
  } else if (u_operation == 5) {
    vec4 over = u_layer ? placedLayerAt(u_source, pixel, u_layerDest, u_layerRegion, u_layerTopDown, u_linear) : layerAt(u_source, pixel, u_size, false, false);
    over *= weight;
    color.a = over.a + inputColor.a * (1.0 - over.a);
    color.rgb = min(vec3(color.a), over.rgb + inputColor.rgb * (u_add ? 1.0 : 1.0 - over.a));
  } else {
    vec2 sourcePixel = pixel;
    vec3 tint = vec3(0.0);
    if (u_operation == 3) {
      if (u_reflectX) sourcePixel.x = 2.0 * u_line - sourcePixel.x;
      else sourcePixel.y = 2.0 * u_line - sourcePixel.y;
    } else {
      if (u_scanlines) {
        vec4 transform = texelFetch(u_rows, ivec2(0, int(pixel.y)), 0);
        vec4 signal = texelFetch(u_rows, ivec2(1, int(pixel.y)), 0);
        if (signal.a < 0.0) {
          if (!u_over) color = inputColor * (1.0 - weight);
          return;
        }
        if (signal.a > 0.0) sourcePixel.y = signal.a - 0.5;
        vec2 pivot = u_size * 0.5;
        sourcePixel = (sourcePixel - pivot) * transform.zw + pivot + transform.xy;
        tint = signal.rgb / 255.0;
      }
      sourcePixel += u_offset + u_amplitude * sin(pixel.yx * u_frequency + u_phase);
      if (u_wrap) sourcePixel = mod(sourcePixel, u_size);
    }
    if (!(all(greaterThanEqual(sourcePixel, vec2(0.0))) && all(lessThan(sourcePixel, u_size)))) return;
    if (u_rejectDepth) {
      if (!u_hasDepth) return;
      float a = depthAt(pixel), b = depthAt(floor(sourcePixel) + 0.5);
      bool aSky = a >= 1.0, bSky = b >= 1.0;
      if (aSky != bSky || (!aSky && abs(a - b) * (u_depthRange.y - u_depthRange.x) > u_depthThreshold)) return;
    }
    vec4 sampled = layerAt(u_source, sourcePixel, u_size, false, false);
    sampled.rgb = clamp(sampled.rgb + tint * sampled.a, vec3(0.0), vec3(sampled.a));
    if (u_over) {
      sampled *= weight;
      color = sampled + inputColor * (1.0 - sampled.a);
    } else color = mix(inputColor, sampled, weight);
  }
}`,Pp=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_current, u_previous, u_pulse, u_masks[8];
uniform vec2 u_size, u_work;
uniform bool u_first, u_hasPulse;
uniform int u_rules, u_masked[8];
uniform vec4 u_rects[8];
uniform ivec4 u_cycle;
uniform ivec3 u_tiles;
out vec4 color;
${Ui}
${cl}

bool inside(vec2 p, vec4 rect) {
  return all(greaterThanEqual(p, rect.xy)) && all(lessThan(p, rect.xy + rect.zw));
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, u_work.y - gl_FragCoord.y) * u_size / u_work;
  vec4 fresh = layerAt(u_current, pixel, u_size, false, false);
  if (u_first) { color = fresh; return; }
  float weight = u_hasPulse ? layerAt(u_pulse, pixel, u_size, false, false).r : 0.0;
  if (tileDue(pixel, u_tiles, u_cycle)) weight = 1.0;
  ${Array.from({length:8},(e,t)=>`
  if (u_rules > ${t} && weight < 1.0 && inside(pixel, u_rects[${t}]))
    weight = max(weight, u_masked[${t}] != 0 ? layerAt(u_masks[${t}], pixel, u_size, false, false).r : 1.0);`).join("")}
  vec4 old = layerAt(u_previous, pixel, u_size, false, false);
  color = floor(mix(old, fresh, weight) * 255.0 + .50001) / 255.0;
}`;function ul(e,{api:t,program:o,resources:s,target:i,textureUnit:r,fullscreen:c,maxSize:l}){let d=o(Cp),n=i(),u=s.texture(),m=s.texture(),p=s.texture(),_=s.texture(),w=s.allocate("Texture"),y=[],F=[],T=s.texture(),f=nl(e,{program:o,target:i,textureUnit:r,fullscreen:c}),x=t.history({release:b=>F.push(b),releaseAge:b=>b.dispose()}),E,R,C;e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_3D,w),e.texParameteri(e.TEXTURE_3D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_3D,e.TEXTURE_MAG_FILTER,e.LINEAR);for(let b of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,b,e.CLAMP_TO_EDGE);e.texImage3D(e.TEXTURE_3D,0,e.RGBA8,1,1,1,0,e.RGBA,e.UNSIGNED_BYTE,new Uint8Array(4)),e.activeTexture(e.TEXTURE0);function V(b,z,v,A){let I=v*A,ae=new Uint8Array(I*4);return Object.fromEntries([...b.captures].map(([W,Z])=>{e.bindFramebuffer(e.READ_FRAMEBUFFER,z.get(W).framebuffer),e.readBuffer(e.COLOR_ATTACHMENT0),e.readPixels(0,0,v,A,e.RGBA,e.UNSIGNED_BYTE,ae);let S=Z==="mask"?1:4,k=new Uint8Array(I*S);for(let M=0,K=0;M<A;M++)for(let P=0;P<v;P++,K++){let L=((A-1-M)*v+P)*4;if(Z==="mask")k[K]=ae[L];else{let N=ae[L+3];if(k[K*4+3]=N,N)for(let H=0;H<3;H++)k[K*4+H]=Math.min(255,Math.round(255*ae[L+H]/N))}}return[W,{kind:Z,width:v,height:A,channels:S,data:k}]}))}function q(b,z,v,{width:A,height:I},ae,W){C??=o(Pp),e.activeTexture(e.TEXTURE0);let Z=F.pop()??i();Z.resize(A,I),r(0,z.textures[0]),r(1,(b.value??z).textures[0]),r(10,(v.get(b.pulse)??z).textures[0]);let S=new Int32Array(8),k=new Int32Array(8),M=new Float32Array(32);for(let L=0;L<S.length;L++){let N=b.regions[L],H=v.get(N?.mask);S[L]=L+2,r(S[L],(H??z).textures[0]),k[L]=+!!H,M.set(N?.rect??[0,0,ae,W],L*4)}let{cycle:K,tiles:P}=sl(b.grid,ae);return c(C,Z.framebuffer,A,I,{u_current:0,u_previous:1,u_pulse:10,u_masks:S,u_size:[ae,W],u_work:[A,I],u_first:b.first,u_hasPulse:!!b.pulse,u_rules:b.regions.length,u_masked:k,u_rects:M,u_cycle:K,u_tiles:P}),Z}function g(b,z,v,A,I,ae,W){if(v.captures.size*A*I>4194304)throw new RangeError("WebGL render graph capture exceeds its readback budget");let Z=t.resources?.(v,A,I);n.resize(A,I);let S,k,M,K;W(b,{...z,...v.needsCamera&&Ro(z,Y=>{k=Y}),...v.needsDepth&&{[Oi](Y,D,_e){M=D,K=_e.depthRange,z[Oi]?.(Y,D,_e)}},[ri]:v.needsOwner?Object.assign((Y,D,_e,Se)=>{S={world:Y,texture:D,depth:_e,view:Se}},{depth:v.needsDepth}):void 0},A,I,n.framebuffer),S?.depth&&(M=S.depth,K=S.view.depthRange),ae||(e.canvas.width!==A&&(e.canvas.width=A),e.canvas.height!==I&&(e.canvas.height=I));for(let Y of[e.BLEND,e.DEPTH_TEST,e.CULL_FACE,e.SCISSOR_TEST,e.STENCIL_TEST])e.disable(Y);e.colorMask(!0,!0,!0,!0),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_3D,w);let P=new Map([["scene",n]]),L=y.slice(),N=new Map,H=z.interfaceTime??z.time??b.lookSnapshot?.time??0,pe=x.begin(v,{source:z.renderHistoryKey??b,w:A,h:I,time:H,camera:k,reset:z.resetRenderHistory}),de=!1;if(v.passes.some(Y=>Y.enabled&&Y.effect)&&S){let Y=t.ownerGroups(S.world),D=Math.min(2048,l),_e=Math.ceil(Y.length/D),Se=new Uint8Array(D*_e*4);for(let Ae=0;Ae<Y.length;Ae++)Se[Ae*4]=Y[Ae]&255,Se[Ae*4+1]=Y[Ae]>>>8&255,Se[Ae*4+2]=Y[Ae]>>>16&255,Se[Ae*4+3]=Y[Ae]>>>24;r(9,T),e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,D,_e,0,e.RGBA,e.UNSIGNED_BYTE,Se),de=!0}let ye;for(let[Y,D]of v.passes.entries()){let _e=P.get(D.input)??n;if((!D.enabled||!S&&(D.type==="history"||(D.type==="frameAge"||D.bank)&&D.select))&&D.type!=="mask")P.set(D.id,_e);else{let Se=L.pop()??i();y.includes(Se)||y.push(Se),Se.resize(A,I);let Ae=D.type==="feedback",B=D.type==="motionSmear",ie=Ae||B||D.type==="history"?pe(D):null,se=D.motion&&t.motionRaster(D,z.renderGraphInputs,A,I),ve=P.get(D.mask),j=D.type==="grade"&&t.cube(D),X=D.enabled&&D.layer&&(!Ae||ie.capture)&&t.layer(D,A,I,b,H,k,e,z.time,z.renderGraphInputs),G=D.window&&D.opacity&&t.windowFrame(D.window,{world:b,time:H,sceneTime:z.time,width:A,height:I,camera:k}),Q=G&&P.get(D.window.sourceMask),be=t.rowTable(D.rows,A,I,H,D.rowEdits),ge=D.schedule&&t.scheduleTable(D.schedule,A,I,H),le=D.indices!==void 0&&t.indexedSchedule(D,z.renderGraphInputs,ge),Re=D.enabled&&S&&D.select&&JSON.stringify(D.select),Pe=D.opacity*(D.layer&&!Ae?X?.opacity??0:1);if(X?.gpu)r(1,X.gpu.texture);else if(X){if(X.w>l||X.h>l)throw new RangeError("Render graph layer exceeds the WebGL texture size limit");r(1,m),e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,X.w,X.h,0,e.RGBA,e.UNSIGNED_BYTE,X.data)}else if(le){if(le.w>l||le.h>l)throw new RangeError("Raster schedule indices exceed the WebGL texture size limit");r(1,m),e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,le.w,le.h,0,e.RGBA,e.UNSIGNED_BYTE,le.data),r(10,_);let he=ge.paletteSize;e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,he,ge.paletteData.length/(he*4),0,e.RGBA,e.UNSIGNED_BYTE,ge.paletteData)}else se?(r(1,m),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,A,I,0,e.RGBA,e.FLOAT,se)):r(1,(P.get(G?.source??D.source??D.field)??n).textures[0]);if(j&&j!==E&&(e.activeTexture(e.TEXTURE4),e.texImage3D(e.TEXTURE_3D,0,e.RGBA8,j.size,j.size,j.size,0,e.RGBA,e.UNSIGNED_BYTE,j.data),E=j),Re&&Re!==ye){if(!N.has(Re)){let me=t.selection(S.world,D.select),fe=Math.min(2048,l),Me=Math.ceil(me.length/fe),we=new Uint8Array(fe*Me);we.set(me),N.set(Re,{width:fe,height:Me,data:we})}let{width:he,height:te,data:ze}=N.get(Re);r(5,u),e.texImage2D(e.TEXTURE_2D,0,e.R8,he,te,0,e.RED,e.UNSIGNED_BYTE,ze),ye=Re}r(0,_e.textures[0]),r(2,(ve??n).textures[0]),r(3,S?.texture??n.textures[0]),r(5,Re?u:n.textures[0]),r(6,M??n.textures[0]);let Ce=D.address&&t.addressRaster(D,z.renderGraphInputs,A,I),Ee=Ce||(ge?.registers??be);r(8,Ee?p:(Q??n).textures[0]),Ee&&e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,Ce?A:2,I,0,e.RGBA,e.FLOAT,Ee);let ke={u_input:0,u_source:1,u_mask:2,u_owner:3,u_cube:4,u_selected:5,u_size:[A,I],u_passSize:[A,I],u_operation:D.window&&!G?0:D.operation,...G&&{u_windowCrop:G.crop,u_windowDest:G.dest,u_windowLine:G.line,u_windowInk:G.ink?.rgba.map(he=>he/255)??[0,0,0,0],u_windowBorder:G.ink?.border??0,u_windowLeader:G.leader,u_windowLinear:G.linear,u_windowHasSourceMask:!!Q,u_auxMask:8},u_opacity:Pe,u_enabled:D.enabled,u_hasMask:!!ve,u_hasSelect:!!Re,u_hasGroups:de,u_packedDepth:!!S?.depth,u_depthMask:!!D.depth,u_depthInvert:D.depth?.invert??!1,u_background:D.depth?.background??!1,u_depthWindow:D.depth?[D.depth.near,D.depth.far,D.depth.feather]:[0,1,0],u_displayMask:D.displayMask??!1,u_budgetLinear:D.budget?.filter==="linear",u_hasRect:!!D.rect,...D.rect&&{u_rect:D.rect,u_feather:D.feather},u_invert:D.invert??!1,u_cubeSize:j?.size??1,u_depth:6,u_history:7,u_blockHold:0,u_volume:!!(D.volume&&M&&k),u_rows:8,u_scanlines:!!be,u_isolated:D.isolated??!1,u_wrap:D.schedule?.wrap??D.wrap??!1,u_over:D.blend==="over",u_addressLinear:D.address?.filter==="linear",u_addressEdges:D.address?.edges??[0,0],u_scheduleIndexed:!!le,u_schedulePalette:le?10:0,u_rejectDepth:D.depthThreshold!==void 0,u_hasDepth:!!M,u_depthThreshold:D.depthThreshold??0,u_depthRange:K??[0,1],...D.volume&&M&&k&&{u_volumeAt:D.volume.at,u_extent:D.volume.extent,u_volumeFeather:D.volume.feather,u_eye:k.eye,u_view:k.view,u_projectionScale:[k.tangent*k.aspect,k.tangent],u_ortho:k.ortho},u_layer:!!X,...X&&{u_layerDest:X.dest,u_layerTopDown:!X.gpu,u_layerRegion:X.gpu?.region??[0,0,X.w,X.h]},u_linear:X?.filter==="linear",u_add:(Ae?D.blend:X?.blend??D.blend)==="add",u_reflectX:D.axis==="x",u_line:D.line??(D.axis==="x"?A:I)*.5,...D.offset&&{u_offset:D.offset,u_amplitude:D.amplitude,u_frequency:2*Math.PI/D.period,u_phase:2*Math.PI*((D.phase+H*D.rate)%1)}};if(D.effect)r(9,de?T:n.textures[0]),f(D,Z.passes[Y],Se,ke,A,I,H,_e.textures[0]);else if(D.bank){let he=pe(D),te=he.capture?q(he,P.get(D.source),P,Z.passes[Y],A,I):he.value;he.save(te),r(0,_e.textures[0]),r(2,(ve??n).textures[0]),r(3,S?.texture??n.textures[0]),r(5,Re?u:n.textures[0]),r(6,M??n.textures[0]),r(7,te.textures[0]),c(d,Se.framebuffer,A,I,ke)}else if(D.type==="frameAge"){let he=pe(D);if(he.capture){let me=Z.passes[Y];e.activeTexture(e.TEXTURE0);let fe=he.spare??i();fe.resize(me.width,me.height),r(0,P.get(D.source).textures[0]),r(7,n.textures[0]),c(d,fe.framebuffer,me.width,me.height,{...ke,u_passSize:[me.width,me.height],u_captureHistory:!0,u_hasMask:!1,u_depthMask:!1,u_hasAuxMask:!1,u_auxMask:8}),he.save(fe)}let te=D.regions.flatMap(me=>{let fe=he.sample(me);return fe?[{stamp:fe,mask:P.get(me.mask)}]:[]});te.length>1&&(e.activeTexture(e.TEXTURE0),R??=i(),R.resize(A,I));let ze=_e;for(let[me,{stamp:fe,mask:Me}]of te.entries()){let we=(te.length-me)%2?Se:R;r(0,ze.textures[0]),r(7,fe.textures[0]),r(8,(Me??n).textures[0]),c(d,we.framebuffer,A,I,{...ke,u_captureHistory:!1,u_hasAuxMask:!!Me,u_auxMask:8}),ze=we}te.length||(r(0,_e.textures[0]),r(7,n.textures[0]),c(d,Se.framebuffer,A,I,{...ke,u_operation:0}))}else if(ie){let he=B?ie.sampleElapsed:0,te=he>0&&(!D.motion||se)?2**(-he/D.halfLife):0,ze=B&&P.get(D.hold),me=te>0||he>0&&!!ze;if(B){let Me=P.get(D.refresh),we=ie.blocks,Fe=we?.rect??[0,0,A,I],{cycle:He,tiles:it}=sl(we?.grid,Fe[2]-Fe[0]);r(8,(Me??n).textures[0]),r(10,(ze??n).textures[0]),Object.assign(ke,{u_auxMask:8,u_hasAuxMask:!!Me,u_hasFlow:!!(D.field||se),u_needsRawMotion:!!D.motion,u_blockMemory:!!we,u_blockHold:10,u_hasBlockHold:!!ze,u_blockRect:Fe,u_blockCycle:He,u_blockTiles:it,u_rawMotion:!!se,u_motionPerFrame:D.units==="pixels/frame",u_flowScale:D.direction==="backward"?D.fieldScale.map(rt=>-rt):D.fieldScale,u_flowVelocity:D.velocity,u_flowBlock:D.blockSize,u_smearElapsed:he,u_decay:te})}let fe=ie.value;if(ie.capture){e.activeTexture(e.TEXTURE0),fe=F.pop()??i();let Me=Z?.passes[Y]??{width:A,height:I};fe.resize(Me.width,Me.height),r(0,_e.textures[0]),r(7,ie.value?.textures[0]??n.textures[0]);let we=Ae&&t.feedbackMotion(D,H,ie.decay>0?ie.elapsed:0,A,I);c(d,fe.framebuffer,Me.width,Me.height,{...ke,u_passSize:[Me.width,Me.height],u_captureHistory:!0,u_hasHistory:B?me:!!ie.value&&(!Ae||ie.decay>0),u_hold:D.mode==="hold",u_decay:B?te:Ae||D.mode==="persistence"?ie.decay:0,...we&&{u_feedbackTransform:we.transform,u_feedbackPivot:we.pivot,u_offset:we.offset,u_amplitude:we.wave,u_frequency:we.frequency,u_phase:we.theta,u_blockSize:we.blockSize,u_feedbackLinear:D.filter==="linear",u_gain:D.gain*(D.layer?X?.opacity??0:1),u_hasThreshold:!!D.threshold,u_threshold:D.threshold??[0,1]}}),ie.save(fe)}r(7,fe.textures[0]),c(d,Se.framebuffer,A,I,{...ke,u_captureHistory:!1,u_hasHistory:!B||me})}else r(7,n.textures[0]),c(d,Se.framebuffer,A,I,ke);P.set(D.id,Se)}for(let Se of D.dependencies)if(v.lastUse.get(Se)===Y){let Ae=P.get(Se);P.delete(Se),Ae!==n&&![...P.values()].includes(Ae)&&L.push(Ae)}}v.captures.size&&z[$n](V(v,P,A,I)),r(0,P.get(v.output).textures[0]),c(d,ae,A,I,{u_operation:0,u_cube:4,u_size:[A,I],u_passSize:[A,I]})}return Object.assign(g,{reset:x.clear})}var Dp=Symbol.for("ink-studio.spriteSurface.uvSlip"),ll=e=>[0,1,2].map(t=>-(e[t*4]*e[12]+e[t*4+1]*e[13]+e[t*4+2]*e[14]));function ga(e,{updatesSince:t,geometryUpdatesSince:o,cutaway:s,samplingPlan:i,samplingGLSL:r,projectionPlan:c,spriteLOD:l,sharedShaders:d,print:n}={}){let u=ur(e);try{let _=function(j,X,G,Q,be,ge,le,Re,Pe,Ce,Ee){let ke=G&&!Q,he=Ce||Ee,te=[j?.airPockets,j?.layered,j?.atlas,!!j,!!X,!!G,Q,!!be?.media,!!be?.lit,ge,le,Re,Pe,Ce,Ee].join("/");if(m.has(te))return m.get(te);let ze=p(`#version 300 es
precision highp float;
layout(location=0) in vec3 a_point;
layout(location=1) in vec2 a_texel;
uniform mat4 u_view,u_proj;
out vec2 v_texel;
out vec3 v_world;
${ke?"layout(location=2)in vec2 a_light;out vec2 v_light;":""}
${he?"layout(location=3)in vec3 a_rest;layout(location=4)in vec2 a_marks;out vec3 v_rest;flat out vec2 v_marks;":""}
out float v_depth;
out vec3 v_camera;
${le?"uniform vec2 u_surfaceViewport;uniform float u_vertexSnap;out vec2 v_affine;":""}
void main(){
  vec4 p=u_view*vec4(a_point,1.0);
  ${ke?"v_light=a_light;":""}
  ${he?"v_rest=a_rest;v_marks=a_marks;":""}
  v_texel=a_texel;v_world=a_point;v_depth=-p.z;v_camera=p.xyz;
  gl_Position=u_proj*p;
  ${le?`
  v_affine=a_texel*gl_Position.w;
  if(u_vertexSnap>0.0&&gl_Position.w>0.0){
    vec2 screen=(gl_Position.xy/gl_Position.w*.5+.5)*u_surfaceViewport;
    screen.y=u_surfaceViewport.y-screen.y;
    screen=floor(screen/u_vertexSnap+.5)*u_vertexSnap;
    screen.y=u_surfaceViewport.y-screen.y;
    gl_Position.xy=(screen/u_surfaceViewport*2.0-1.0)*gl_Position.w;
  }`:""}
}`,`#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform vec4 u_range,u_splatPlane;
${j?kr(j.airPockets,j.layered,j.atlas):"uniform vec4 u_arrivalPlane;"}
uniform vec2 u_surfaceViewport;
uniform vec3 u_fog;
uniform bool u_index, u_graphDepth, u_portalCover;
uniform bool u_uvSlip, u_filterMatte;
uniform float u_filterSoftness;
${Re?"uniform int u_geometryCode;uniform vec2 u_partGrid;"+l:""}
uniform vec4 u_uvTransform, u_uvBounds;
${ge?`uniform float u_samplingScale;
${r}`:""}
${X?s:""}
${be?.media?Kt(be.lit):""}
${G?Ni:""}
${ke?"uniform highp sampler2DArray u_surfaceLit;uniform int u_surfaceLightCount;in vec2 v_light;":""}
${Q?"uniform highp sampler2D u_surfaceNormalMap;uniform bool u_surfaceNormals;uniform vec3 u_surfaceEye;":""}
${he?"in vec3 v_rest;flat in vec2 v_marks;":""}
${Ee?`uniform float u_engravingArtScale;${ko(n)}`:""}
in vec2 v_texel;
in vec3 v_world;
in float v_depth;
in vec3 v_camera;
${le?"uniform bool u_affine;uniform vec4 u_projectionBounds;in vec2 v_affine;":""}
layout(location=0) out vec4 color;
layout(location=1) out vec4 depth;
${Pe&&!j?"vec4 water;":"layout(location=2) out vec4 water;"}
${Pe?Li(j):""}
${Q?`
vec3 surfaceNormal(vec3 normal,vec3 dx,vec3 dy,vec2 du,vec2 dv,vec4 map){
  float det=du.x*dv.y-du.y*dv.x;
  if(map.a<.5||abs(det)<=1e-5*length(du)*length(dv))return normal;
  vec3 local=max(vec3(-127),round(map.rgb*255.0)-128.0);
  if(dot(local,local)==0.0)return normal;
  vec3 tangent=normalize(dx*dv.y-dy*du.y)*sign(det);
  vec3 bitangent=cross(normal,tangent);
  // Positive map Y faces up the texture, opposite increasing row coordinates.
  bitangent*=dot(bitangent,(dx*dv.x-dy*du.x)*sign(det))<0.0?-1.0:1.0;
  return normalize(mat3(tangent,bitangent,normal)*local);
}
`:""}
void main(){
  ${Re?"if(!spriteGeometry(u_geometryCode,gl_FragCoord.xy*u_partGrid))discard;":""}
  vec2 uv=${le?"u_affine?v_affine*gl_FragCoord.w:v_texel":"v_texel"};
  vec2 rawTexel=u_uvSlip?uv*u_uvTransform.xy+u_uvTransform.zw:uv;
  vec2 texel=u_uvSlip?clamp(rawTexel,u_uvBounds.xy,u_uvBounds.zw):rawTexel;
  ${le?"if(u_affine&&!u_uvSlip)texel=clamp(texel,u_projectionBounds.xy,u_projectionBounds.zw);":""}
  ${ge?`
  if(u_paletteSampling)texel=clamp(texel,u_sampleRegion.xy,u_sampleRegion.xy+u_sampleRegion.zw-1.0);
  `:""}
  vec4 ink=texelFetch(u_atlas,ivec2(texel),0);
  ${ge?`
  float q=gl_FragCoord.w;
  vec2 numerator=v_texel*q;
  vec2 scale=u_samplingScale*(u_uvSlip?u_uvTransform.xy:vec2(1.0));
  vec2 dx=(dFdx(numerator)-v_texel*dFdx(q))*scale/q;
  vec2 dy=(dFdy(numerator)-v_texel*dFdy(q))*scale/q;
  ${le?"if(u_affine){dx=dFdx(uv)*scale;dy=dFdy(uv)*scale;}":""}
  if(u_paletteSampling)ink=samplePalette(rawTexel,dx,dy,ink);
  `:""}
  ${Q?`
  // Use the surface UV frame even when affine sampling or snapping changes the lookup.
  vec3 dpdx=dFdx(v_world),dpdy=dFdy(v_world);
  vec3 geometricNormal=normalize(cross(dpdx,dpdy));
  if(dot(geometricNormal,u_surfaceEye-v_world)<0.0)geometricNormal=-geometricNormal;
  vec2 scaleUV=u_uvSlip?u_uvTransform.xy:vec2(1);
  vec2 uvDx=dFdx(v_texel)*scaleUV,uvDy=dFdy(v_texel)*scaleUV;
  `:""}
  ${Ee?"vec3 restX=dFdx(v_rest),restY=dFdy(v_rest),worldX=dFdx(v_world),worldY=dFdy(v_world);vec2 texX=dFdx(v_texel),texY=dFdy(v_texel);":""}
  if(ink.a<.5||dot(u_arrivalPlane,vec4(v_world,1.0))<0.0||dot(u_splatPlane,vec4(v_camera,1.0))<0.0)discard;
  ${X?"float margin=sectionMargin(v_world,v_depth); if(margin<0.0)discard;":""}
  ${Ce?"color=vec4(v_world,v_marks.x);depth=vec4(v_rest,1);return;":""}
  if(u_filterMatte){color=vec4(vec3(u_filterSoftness),1);depth=vec4(0);water=vec4(0);return;}
  float d=clamp((v_depth-u_range.x)/(u_range.y-u_range.x),0.0,1.0);
  float fog=u_range.z<1.0?smoothstep(u_range.z,1.0,d)*u_range.w:0.0;
  vec3 mark=vec3(0.0), rgb=ink.rgb;
  ${ke?"vec3 irradiance=vec3(0);for(int i=0;i<32;i++){if(i>=u_surfaceLightCount)break;irradiance+=texelFetch(u_surfaceLit,ivec3(ivec2(v_light),i),0).rgb;}rgb=eSRGB(min(vec3(1),eLinear(rgb)*(vec3(1)+irradiance)));":""}
  ${Q?`
  vec4 map=u_surfaceNormals?texelFetch(u_surfaceNormalMap,ivec2(texel),0):vec4(0);
  vec3 normal=surfaceNormal(geometricNormal,dpdx,dpdy,uvDx,uvDy,map);
  vec3 irradiance=eLighting(v_world,normal,false,vec3(0),geometricNormal);
  rgb=eSRGB(min(vec3(1),eLinear(rgb)*(vec3(1)+irradiance)));
  `:""}
  ${Ee?`
  if(v_marks.y>0.0){
    vec3 restN=cross(restX,restY),liveN=cross(worldX,worldY);
    if(length(restN)>1e-12&&length(liveN)>1e-12){
      restN=normalize(restN);
      float det=texX.x*texY.y-texX.y*texY.x;
      vec3 tangent=abs(det)>1e-9 ? (restX*texY.y-restY*texX.y)*sign(det) :
        cross(abs(restN.x)<.8?vec3(1,0,0):vec3(0,1,0),restN);
      rgb=surfaceEngraving(int(v_marks.y),rgb,v_rest,restN,normalize(tangent),normalize(liveN),
        max(length(restX),length(restY)),u_engravingArtScale,0.,vec3(0));
    }
  }`:""}
  ${j?"if(!u_index)rgb=waterPaint(rgb,gl_FragCoord.xy,u_surfaceViewport,v_depth,mark);":""}
  ${be?.media?"if(!u_index)rgb=envMedia(rgb,gl_FragCoord.xy,u_surfaceViewport,v_depth);":""}
  rgb=mix(rgb,u_fog,fog);
  ${X?"rgb=mix(rgb,u_sectionEdge.rgb,sectionInk(margin));":""}
  color=u_index?vec4(float(u_portalCover)):vec4(rgb,1.0);
  depth=vec4(d,0.0,0.0,1.0);water=vec4(mark,1.0);
  ${Pe?"splitOpaqueSurface(color,gl_FragCoord.z);":""}
  if(u_index&&u_graphDepth){float z=round(d*16777215.0);water=vec4(mod(z,256.0),mod(floor(z/256.0),256.0),floor(z/65536.0),255.0)/255.0;}
}`);return m.set(te,ze),ze},v=function(j){if(z.textureBytes=0,z.geometryBytes=0,g)throw new Error("Surface pipeline has been disposed");let X=j?.revision??0,G=j?.geometryRevision??0;if(T===j&&R===X&&C===G&&f===j.vertices&&x===j.normalPixels&&V===j.width&&q===j.height)return;if(!j||!(j.vertices instanceof Float32Array)||j.vertices.length%15||!Number.isSafeInteger(j.width)||j.width<1||!Number.isSafeInteger(j.height)||j.height<1||!(j.pixels instanceof Uint8Array)||j.pixels.length!==j.width*j.height*4||j.normalPixels!==void 0&&(!(j.normalPixels instanceof Uint8Array)||j.normalPixels.length!==j.pixels.length)||!Number.isSafeInteger(X)||X<0||!Number.isSafeInteger(G)||G<0)throw new RangeError("Invalid sprite surface atlas");if(Math.max(j.width,j.height)>e.getParameter(e.MAX_TEXTURE_SIZE))throw new RangeError("Surface atlas exceeds GPU size limit");let Q=T!==j||V!==j.width||q!==j.height;if(Q||f!==j.vertices){if(!j.vertices.every(Number.isFinite))throw new RangeError("Invalid sprite surface geometry");e.bindBuffer(e.ARRAY_BUFFER,y),e.bufferData(e.ARRAY_BUFFER,j.vertices,G?e.DYNAMIC_DRAW:e.STATIC_DRAW),z.geometryBytes=j.vertices.byteLength}if(!Q&&f===j.vertices&&C!==G){let Ee=o?.(j,C),ke=Ee?.length?Math.min(...Ee.map(ze=>ze.first)):0,he=Ee?.length?Math.max(...Ee.map(ze=>ze.first+ze.count)):j.vertices.length/5,te=j.vertices.subarray(ke*5,he*5);if(!te.every(Number.isFinite))throw new RangeError("Invalid sprite surface geometry");e.bindBuffer(e.ARRAY_BUFFER,y),e.bufferSubData(e.ARRAY_BUFFER,ke*20,te),z.geometryBytes=te.byteLength}let be=0,ge=0,le=j.width,Re=j.height;if(!Q&&R!==X){let Ee=t?.(j,R);Ee?.length&&(be=Math.min(...Ee.map(ke=>ke.x)),ge=Math.min(...Ee.map(ke=>ke.y)),le=Math.max(...Ee.map(ke=>ke.x+ke.width))-be,Re=Math.max(...Ee.map(ke=>ke.y+ke.height))-ge)}function Pe(Ee,ke){if(ke){e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,j.width,j.height,0,e.RGBA,e.UNSIGNED_BYTE,Ee),z.textureBytes+=Ee.byteLength;return}let he=le*Re*4;b.length<he&&(b=new Uint8Array(he));for(let te=0;te<Re;te++)b.set(Ee.subarray(((ge+te)*j.width+be)*4,((ge+te)*j.width+be+le)*4),te*le*4);e.texSubImage2D(e.TEXTURE_2D,0,be,ge,le,Re,e.RGBA,e.UNSIGNED_BYTE,b.subarray(0,he)),z.textureBytes+=he}e.activeTexture(e.TEXTURE0+6),(Q||R!==X)&&(e.bindTexture(e.TEXTURE_2D,F),Pe(j.pixels,Q));let Ce=x!==j.normalPixels;j.normalPixels&&(Q||Ce||R!==X)&&(e.activeTexture(e.TEXTURE0+24),E??=u.texture(),e.bindTexture(e.TEXTURE_2D,E),Pe(j.normalPixels,Q||Ce)),T=j,f=j.vertices,x=j.normalPixels,R=X,C=G,V=j.width,q=j.height},Se=function(j,X,G){let Q=(X?.key??"")+"|"+(G?.key??""),be=j.geometryRevision??0,ge=j.surfaceCharts??[],le=!j.sceneMeshId||ge.some(Ee=>!Ee.rest);if(ye&&Y===j&&D===Q&&(!le||be===_e))return;let Re=j.vertices.length/5,Pe=new Float32Array(Re*5),Ce=0;for(let Ee=0;Ee<Re;Ee++){for(;ge[Ce]?.end<=Ee;)Ce++;let ke=ge[Ce]?.first<=Ee?ge[Ce]:void 0,he=(Ee-(ke?.first??0))*3;Pe.set(ke?.rest?.subarray(he,he+3)??j.vertices.subarray(Ee*5,Ee*5+3),Ee*5),Pe[Ee*5+3]=X?.select(ke?.objectId,ke?.materialId)??0,Pe[Ee*5+4]=G?.mesh(ke)??0}ye??=u.allocate("Buffer"),e.bindVertexArray(w),e.bindBuffer(e.ARRAY_BUFFER,ye),e.bufferData(e.ARRAY_BUFFER,Pe,le?e.DYNAMIC_DRAW:e.STATIC_DRAW),e.vertexAttribPointer(3,3,e.FLOAT,!1,20,0),e.vertexAttribPointer(4,2,e.FLOAT,!1,20,12),Y=j,D=Q,_e=be},Ae=function(j,X,G){let Q=X.frame.emitterSurfaceResolution??16;if(!Number.isSafeInteger(Q)||Q<4||Q>64)throw new RangeError("Surface light resolution must be 4..64");let be=Math.min(64,Math.floor(e.getParameter(e.MAX_TEXTURE_SIZE)/Q));if(M!==j.vertices||K!==(j.geometryRevision??0)||N!==Q){N=Q,L=j.vertices.length/15,P=new Float32Array(L*9);let he=new Float32Array(L*6);for(let te=0;te<L;te++){let ze=te%be*Q,me=Math.floor(te/be)*Q;for(let fe=0;fe<3;fe++)P.set(j.vertices.subarray(te*15+fe*5,te*15+fe*5+3),te*9+fe*3),he.set([ze+.5+(fe===1?Q-1:0),me+.5+(fe===2?Q-1:0)],te*6+fe*2)}e.bindBuffer(e.ARRAY_BUFFER,pe),e.bufferData(e.ARRAY_BUFFER,P,e.DYNAMIC_DRAW),e.bindBuffer(e.ARRAY_BUFFER,de),e.bufferData(e.ARRAY_BUFFER,he,e.DYNAMIC_DRAW),M=j.vertices,K=j.geometryRevision??0}let ge=ll(G),le=0;for(let he=0;he<P.length;he+=9){let te=P.subarray(he,he+3),ze=[0,1,2].map(Me=>P[he+3+Me]-te[Me]),me=[0,1,2].map(Me=>P[he+6+Me]-te[Me]),fe=[ze[1]*me[2]-ze[2]*me[1],ze[2]*me[0]-ze[0]*me[2],ze[0]*me[1]-ze[1]*me[0]];le=Math.imul(le,31)+(fe.reduce((Me,we,Fe)=>Me+we*(ge[Fe]-te[Fe]),0)<0?1:0)|0}let Re=[M,K,X.shadow,X.cutoutRevision,Q],Pe=(he,te)=>he?.length===te.length&&te.every((ze,me)=>ze===he[me]);if(Pe(Z,Re)&&Pe(S,X.rows)&&le===k){e.activeTexture(e.TEXTURE0+24),e.bindTexture(e.TEXTURE_2D_ARRAY,I);return}let Ce=!Pe(Z,Re)||le!==k,Ee=S;if(Z=Re,S=X.rows.slice(),k=le,!I){I=u.allocate("Texture"),e.activeTexture(e.TEXTURE0+24),e.bindTexture(e.TEXTURE_2D_ARRAY,I);for(let he of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_2D_ARRAY,he,e.NEAREST);for(let he of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T])e.texParameteri(e.TEXTURE_2D_ARRAY,he,e.CLAMP_TO_EDGE)}ae??=u.allocate("Framebuffer"),e.activeTexture(e.TEXTURE0+24),e.bindTexture(e.TEXTURE_2D_ARRAY,I);let ke=[be*Q,Math.max(1,Math.ceil(L/be))*Q];if(ke[1]>e.getParameter(e.MAX_TEXTURE_SIZE))throw new RangeError("Surface lighting charts exceed the GPU atlas budget");if(W[0]!==ke[0]||W[1]!==ke[1]||W[2]!==X.count){if(ke[0]*ke[1]*X.count>16777216)throw new RangeError("Surface lighting cache exceeds its texel budget");e.texImage3D(e.TEXTURE_2D_ARRAY,0,e.RGBA16F,...ke,Math.max(1,X.count),0,e.RGBA,e.FLOAT,null),W=[...ke,X.count],Ce=!0}if(e.bindFramebuffer(e.FRAMEBUFFER,ae),e.framebufferTextureLayer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,I,0,0),e.drawBuffers([e.COLOR_ATTACHMENT0]),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw new Error("Surface lightmap target is incomplete");A??=u.program(`#version 300 es
precision highp float;layout(location=0)in vec3 a_a;layout(location=1)in vec3 a_b;layout(location=2)in vec3 a_c;uniform vec2 u_lightSize;uniform float u_lightResolution;uniform int u_lightColumns;uniform vec3 u_surfaceEye;out vec3 v_world;flat out vec3 v_normal;void main(){vec2 q=vec2(gl_VertexID&1,gl_VertexID>>1);vec2 uv=(q*u_lightResolution-.5)/(u_lightResolution-1.0);v_world=a_a+(a_b-a_a)*uv.x+(a_c-a_a)*uv.y;v_normal=normalize(cross(a_b-a_a,a_c-a_a));if(dot(v_normal,u_surfaceEye-a_a)<0.0)v_normal=-v_normal;vec2 tile=vec2(gl_InstanceID%u_lightColumns,gl_InstanceID/u_lightColumns)*u_lightResolution;gl_Position=vec4((tile+q*u_lightResolution)/u_lightSize*2.0-1.0,0,1);}`,`#version 300 es
precision highp float;${Ni}
in vec3 v_world;flat in vec3 v_normal;out vec4 color;void main(){color=vec4(eLighting(v_world,v_normal,false,vec3(0)),1);}`),e.disable(e.BLEND),e.disable(e.DEPTH_TEST),e.viewport(0,0,W[0],W[1]),e.useProgram(A.p),A.set({...X.uniforms,u_lightSize:W.slice(0,2),u_lightColumns:be,u_lightResolution:Q,u_surfaceEye:ge}),e.bindVertexArray(H);for(let he=0;he<X.count;he++)!Ce&&Pe(Ee?.subarray(he*44,he*44+44),X.rows.subarray(he*44,he*44+44))||(e.framebufferTextureLayer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,I,0,he),e.clearBufferfv(e.COLOR,0,[0,0,0,0]),A.set({u_ePick:he+1}),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,L))},se=function(j){let X=B.get(j);if(!X){let be=function(Re,Pe){e.activeTexture(e.TEXTURE0+Re);let Ce=u.texture();return e.texImage2D(e.TEXTURE_2D,0,e.RGBA32UI,G+1,Q+1,0,e.RGBA_INTEGER,e.UNSIGNED_INT,Pe),z.textureBytes+=Pe.byteLength,Ce},{width:G,height:Q}=j.rect,ge=be(ie[0],j.totals),le=j.accents?be(ie[1],j.accents):ge;X=[ge,le],B.set(j,X)}for(let G=0;G<ie.length;G++)e.activeTexture(e.TEXTURE0+ie[G]),e.bindTexture(e.TEXTURE_2D,X[G])},ve=function(j,{lighting:X,environment:G,view:Q,projection:be,range:ge,fog:le,index:Re=!1,graphDepth:Pe=!1,glassLayers:Ce=!1,portalCover:Ee=!1,arrivalPlane:ke=[0,0,0,0],clip:he=[0,0,0,0],water:te,wet:ze,width:me=1,height:fe=1,paletteSampling:Me,surfaceNormals:we=!0,samplingScale:Fe=1,geometryCode:He=0,partGrid:it=[1,1],section:rt,anchors:et,engraving:Yt,coverageFilter:Zt}){if(v(j),Me!==!1&&j.paletteSampling!==void 0&&(!i||!r))throw new TypeError("Palette-filtered surfaces need SpriteSurface.samplingPlan and samplingGLSL");if(j.projectionRanges!==void 0&&!c)throw new TypeError("Styled surface projection needs SpriteSurface.projectionPlan");let ft=c?.(j)??[],vt=Me===!1?null:i?.(j),oe=new Set((vt??[]).map($e=>$e.filter).filter(Boolean));for(let[$e,Je]of B)if(!oe.has($e)){for(let Pt of new Set(Je))u.free(Pt);B.delete($e)}let Xe=oe.size>0,tt=!!(X?.active&&!Re&&!Zt),Ye=tt&&!!j.normalPixels;if(Ye)e.activeTexture(e.TEXTURE0+24),e.bindTexture(e.TEXTURE_2D,E);else if(tt){let $e=e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),Je=e.getParameter(e.VIEWPORT),Pt=e.isEnabled(e.BLEND),gt=e.isEnabled(e.DEPTH_TEST);Ae(j,X,Q),e.bindFramebuffer(e.FRAMEBUFFER,$e),e.viewport(...Je),Pt?e.enable(e.BLEND):e.disable(e.BLEND),gt?e.enable(e.DEPTH_TEST):e.disable(e.DEPTH_TEST)}e.activeTexture(e.TEXTURE0+6),e.bindTexture(e.TEXTURE_2D,F);let Ge=!Zt&&!Re&&Yt&&j.surfaceCharts?.some($e=>Yt.mesh($e))?Yt:null;(Ge||et)&&Se(j,et,Ge),Ge&&Ge.bind();let Rt=_(ze,rt,tt,Ye,G,Xe,ft.length>0,!!He,Ce,!!et,!!Ge);e.useProgram(Rt.p),Rt.set({u_view:Q,u_proj:be,u_range:ge,u_fog:le,u_atlas:6,...Xe&&{u_sampleTotals:ie[0],u_sampleAccents:ie[1],u_samplingScale:Fe},u_surfaceLightCount:X?.count??0,u_surfaceLit:24,...Ye&&{u_surfaceNormalMap:24,u_surfaceNormals:we,u_surfaceEye:ll(Q)},u_index:+Re,u_filterMatte:!!Zt,u_glassBoundary:13,u_graphDepth:Pe,u_portalCover:Ee,u_arrivalPlane:ke,u_splatPlane:he,u_surfaceViewport:[me,fe],u_geometryCode:He,u_partGrid:it,...Ge&&{...Ge.uniforms,u_engravingArtScale:Fe},...te,...rt,...G?.uniforms,...X?.uniforms}),e.bindVertexArray(w);for(let $e of[3,4])Ge||et?e.enableVertexAttribArray($e):e.disableVertexAttribArray($e);tt&&!Ye?e.enableVertexAttribArray(2):e.disableVertexAttribArray(2);let xt=0;function yt($e,Je){if(!ft.length){e.drawArrays(e.TRIANGLES,$e,Je-$e);return}for(;$e<Je;){for(;ft[xt]?.end<=$e;)xt++;let Pt=ft[xt],gt=Pt?.first<=$e?Pt:null,bt=Math.min(Je,(gt?gt.end:Pt?.first)??Je);Rt.set({u_affine:gt?.affine??!1,u_vertexSnap:(gt?.vertexSnap??0)*Fe,...gt?.affine&&{u_projectionBounds:gt.bounds}}),e.drawArrays(e.TRIANGLES,$e,bt-$e),$e=bt}}let wt=0;function ut($e,Je){if(!Zt){yt($e,Je);return}let Pt=j.surfaceCharts??[];for(;$e<Je;){for(;Pt[wt]?.end<=$e;)wt++;let gt=Pt[wt],bt=gt?.first<=$e?gt:null,at=Math.min(Je,(bt?bt.end:gt?.first)??Je);Rt.set({u_filterSoftness:Zt.at(bt?.materialId)}),yt($e,at),$e=at}}if(Xe){let $e=ie.map(Je=>(e.activeTexture(e.TEXTURE0+Je),e.getParameter(e.TEXTURE_BINDING_2D)));try{let Je=oe.values().next().value;se(Je);for(let{first:Pt,end:gt,shift:bt,filter:at}of vt)at&&at!==Je&&(se(at),Je=at),Rt.set({u_uvSlip:!!bt,...bt&&{u_uvTransform:bt.transform,u_uvBounds:bt.bounds},u_paletteSampling:!!at,...at&&{u_sampleRegion:[at.rect.x,at.rect.y,at.rect.width,at.rect.height],u_sampleRule:[at.rule.alphaCoverage,at.rule.protectCoverage,at.rule.tieTolerance],u_sampleCount:at.colors.length,...at.swatches.length&&{u_sampleSwatches:at.swatches},u_protectCount:at.rule.protect.length,...at.highlights.length&&{u_sampleProtected:at.highlights}}}),ut(Pt,gt)}finally{for(let Je=0;Je<ie.length;Je++)e.activeTexture(e.TEXTURE0+ie[Je]),e.bindTexture(e.TEXTURE_2D,$e[Je]);e.activeTexture(e.TEXTURE0)}return}let Wr=j[Dp],wi=Wr?.vertices===j.vertices&&Wr.width===j.width&&Wr.height===j.height?Wr.ranges:[],ar=0;for(let{first:$e,end:Je,transform:Pt,bounds:gt}of wi)$e>ar&&(Rt.set({u_uvSlip:!1}),ut(ar,$e)),Rt.set({u_uvSlip:!0,u_uvTransform:Pt,u_uvBounds:gt}),ut($e,Je),ar=Je;let $t=T.vertices.length/5;ar<$t&&(Rt.set({u_uvSlip:!1}),ut(ar,$t)),e.activeTexture(e.TEXTURE0)},m=d?.cache??new Map,p=d?.program??u.program,w=u.allocate("VertexArray"),y=u.allocate("Buffer"),F=u.texture();e.bindVertexArray(w),e.bindBuffer(e.ARRAY_BUFFER,y),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,3,e.FLOAT,!1,20,0),e.enableVertexAttribArray(1),e.vertexAttribPointer(1,2,e.FLOAT,!1,20,12),e.bindVertexArray(null);let T,f,x,E,R=-1,C=-1,V=0,q=0,g=!1,b=new Uint8Array(0),z={textureBytes:0,geometryBytes:0},A,I,ae,W=[],Z,S,k,M,K,P,L,N,H=u.allocate("VertexArray"),pe=u.allocate("Buffer"),de=u.allocate("Buffer");e.bindVertexArray(w),e.bindBuffer(e.ARRAY_BUFFER,de),e.enableVertexAttribArray(2),e.vertexAttribPointer(2,2,e.FLOAT,!1,8,0),e.bindVertexArray(H),e.bindBuffer(e.ARRAY_BUFFER,pe);for(let j=0;j<3;j++)e.enableVertexAttribArray(j),e.vertexAttribPointer(j,3,e.FLOAT,!1,36,j*12),e.vertexAttribDivisor(j,1);e.bindVertexArray(null);let ye,Y,D,_e,B=new Map,ie=[1,2];return{draw:ve,get stats(){return{...z}},dispose(){g||(g=!0,u.dispose())}}}catch(m){throw u.dispose(),m}}var Ip=`#version 300 es
precision highp float;
layout(location=0) in vec3 a_position;
uniform mat4 u_view,u_projection;
out vec3 v_world,v_camera;
void main(){
  v_world=a_position;
  vec4 camera=u_view*vec4(a_position,1.0);
  v_camera=camera.xyz;
  gl_Position=u_projection*camera;
}`;function Lp(e){return`#version 300 es
precision highp float;
in vec3 v_world,v_camera;
uniform mat4 u_projection;
uniform vec4 u_arrivalPlane,u_clip;
uniform float u_tolerance;
${e??""}
void main(){
  if(dot(u_arrivalPlane,vec4(v_world,1.0))<0.0||dot(u_clip,vec4(v_camera,1.0))<0.0)discard;
  ${e?"if(sectionMargin(v_world,-v_camera.z)<0.0)discard;":""}
  vec4 p=u_projection*vec4(0.0,0.0,v_camera.z-u_tolerance,1.0);
  gl_FragDepth=clamp(p.z/p.w*0.5+0.5,0.0,1.0);
}`}function fl(e,t,o){let s=ur(e);try{let _=function(y,F){let T=n[F];T?e.bindVertexArray(T.vao):(T=n[F]={vao:s.allocate("VertexArray"),positions:s.allocate("Buffer"),indices:s.allocate("Buffer")},e.bindVertexArray(T.vao),e.bindBuffer(e.ARRAY_BUFFER,T.positions),e.vertexAttribPointer(0,3,e.FLOAT,!1,0,0),e.enableVertexAttribArray(0),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,T.indices)),T.points!==y.positions&&(e.bindBuffer(e.ARRAY_BUFFER,T.positions),T.points?.length===y.positions.length?e.bufferSubData(e.ARRAY_BUFFER,0,y.positions):e.bufferData(e.ARRAY_BUFFER,y.positions,e.DYNAMIC_DRAW),T.points=y.positions),T.faces!==y.indices&&(e.bufferData(e.ELEMENT_ARRAY_BUFFER,y.indices,e.STATIC_DRAW),T.faces=y.indices),e.drawElements(e.TRIANGLES,y.indices.length,e.UNSIGNED_INT,0)},w=function(y,F,T){let{depthProxy:f,view:x,projection:E,arrivalPlane:R,clip:C,section:V}=y;if(p?.plan===f&&p.clip===C&&F===u&&T===m)return c;if(e.bindFramebuffer(e.FRAMEBUFFER,l),u!==F||m!==T){e.activeTexture(e.TEXTURE0+t);let b=i();if(e.bindTexture(e.TEXTURE_2D,c),e.texImage2D(e.TEXTURE_2D,0,e.DEPTH_COMPONENT24,F,T,0,e.DEPTH_COMPONENT,e.UNSIGNED_INT,null),e.bindTexture(e.TEXTURE_2D,b),e.framebufferTexture2D(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.TEXTURE_2D,c,0),e.drawBuffers([e.NONE]),e.readBuffer(e.NONE),e.checkFramebufferStatus(e.FRAMEBUFFER)!==e.FRAMEBUFFER_COMPLETE)throw new Error("Splat depth proxy framebuffer is incomplete");u=F,m=T}let q=!!V;d.has(q)||d.set(q,s.program(Ip,Lp(q?o:null)));let g=d.get(q);e.viewport(0,0,F,T),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),e.depthMask(!0),e.clearBufferfv(e.DEPTH,0,[1]),e.useProgram(g.p),g.set({u_view:x,u_projection:E,u_arrivalPlane:R,u_clip:C,u_tolerance:f.tolerance,...V});for(let[b,z]of f.meshes.entries())_(z,b);return e.bindVertexArray(null),e.disable(e.DEPTH_TEST),p={plan:f,clip:C},c};e.activeTexture(e.TEXTURE0+t);let i=()=>e.getParameter(e.TEXTURE_BINDING_2D),r=i(),c=s.texture(),l=s.allocate("Framebuffer");e.bindTexture(e.TEXTURE_2D,r);let d=new Map,n=[],u=0,m=0,p;return{prepare:w,dispose:s.dispose}}catch(i){throw s.dispose(),i}}var Bp=32*1024*1024,pl=29;function dl(e,t,o){let s=ur(e),i=new Map,r=new Map,c=0,l=s.allocate("VertexArray");function d(u){let m=i.get(u);if(m){i.delete(u),i.set(u,m),e.bindTexture(e.TEXTURE_2D_ARRAY,m);return}for(;c+u.values.byteLength>Bp&&i.size;){let[_,w]=i.entries().next().value;s.free(w),c-=_.values.byteLength,i.delete(_)}m=s.allocate("Texture"),e.bindTexture(e.TEXTURE_2D_ARRAY,m),e.texParameteri(e.TEXTURE_2D_ARRAY,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D_ARRAY,e.TEXTURE_MAG_FILTER,e.NEAREST);let p=u.values.length/(u.width*u.height*4);e.texImage3D(e.TEXTURE_2D_ARRAY,0,e.RGBA32F,u.width,u.height,p,0,e.RGBA,e.FLOAT,u.values),i.set(u,m),c+=u.values.byteLength}function n(u,m,p,_){let w=[!!u,u?.airPockets,u?.layered,u?.atlas,!!m,!!p?.media,!!p?.lit,_].join("/");if(r.has(w))return r.get(w);let y=s.program(`#version 300 es
precision highp float;
uniform mat4 u_view,u_proj;
uniform vec3 u_anchor,u_right,u_up;
uniform vec2 u_size,u_pivot;
uniform float u_units;
out vec2 v_texel;
out vec3 v_world;
void main(){
  vec2 corner=vec2(gl_VertexID & 1,gl_VertexID >> 1)*u_size;
  v_texel=corner;
  v_world=u_anchor+u_units*((corner.x-u_pivot.x)*u_right+(u_pivot.y-corner.y)*u_up);
  gl_Position=u_proj*u_view*vec4(v_world,1.0);
}`,`#version 300 es
precision highp float; precision highp int;
uniform highp sampler2DArray u_sprite;
uniform mat4 u_view,u_proj;
uniform mat3 u_normalAxes;
uniform vec3 u_eye,u_plane,u_back,u_fog,u_sun;
uniform vec4 u_range,u_splatPlane;
uniform vec2 u_surfaceViewport,u_artScale,u_sunGain,u_size;
uniform int u_phase,u_step;
uniform bool u_ortho,u_depth,u_normal,u_emission,u_baked,u_effect,u_index,u_graphDepth,u_portalCover,u_markPass;
uniform float u_scale,u_effectDepth,u_filterSoftness;
uniform bool u_filterMatte;
${u?kr(u.airPockets,u.layered,u.atlas):"uniform vec4 u_arrivalPlane;"}
${m?o:""}
${p?.media?Kt(p.lit):""}
${t.glsl}
in vec2 v_texel;
in vec3 v_world;
layout(location=0) out vec4 color;
layout(location=1) out vec4 depth;
${_&&!u?"vec4 water;":"layout(location=2) out vec4 water;"}
${_?Li(u):""}
void main(){
  vec2 pixel=gl_FragCoord.xy*u_artScale;
  if(spriteRank(pixel,u_phase)<u_step)discard;
  ivec2 size=textureSize(u_sprite,0).xy;
  vec2 texel=all(equal(vec2(size),u_size))?v_texel:v_texel/u_size*vec2(size);
  ivec2 tx=clamp(ivec2(texel),ivec2(0),size-1);
  vec4 ink=texelFetch(u_sprite,ivec3(tx,u_effect?3:0),0);
  if(ink.a*64.0<=float(spriteRank(pixel+vec2(3,5),u_phase^45)))discard;
  vec4 material=texelFetch(u_sprite,ivec3(tx,1),0);
  vec3 ray=u_ortho?-u_back:normalize(v_world-u_eye);
  float facing=-dot(ray,u_plane);
  if(facing<=1.0e-7)discard;
  vec3 position=v_world+ray*(u_depth?(u_effect?u_effectDepth:material.w)*u_scale/facing:0.0);
  vec4 camera=u_view*vec4(position,1.0);
  if(dot(u_arrivalPlane,vec4(position,1.0))<0.0||dot(u_splatPlane,camera)<0.0)discard;
  vec4 projected=u_proj*camera;
  float z=0.5+0.5*projected.z/projected.w;
  if(z<0.0||z>1.0||projected.w<=0.0)discard;
  gl_FragDepth=z;
  if(u_markPass){color=vec4(0);depth=vec4(0);return;}
  float axial=-camera.z;
  ${m?"float margin=sectionMargin(position,axial);if(margin<0.0)discard;":""}
  float d=clamp((axial-u_range.x)/(u_range.y-u_range.x),0.0,1.0);
  float fog=u_range.z<1.0?smoothstep(u_range.z,1.0,d)*u_range.w:0.0;
  vec3 glow=u_emission&&!u_effect?texelFetch(u_sprite,ivec3(tx,2),0).rgb:vec3(0);
  float gain=u_normal&&!u_effect&&dot(material.xyz,material.xyz)>1.0e-8?
    u_sunGain.x+u_sunGain.y*max(0.0,dot(normalize(u_normalAxes*material.xyz),u_sun)):1.0;
  vec3 rgb=u_baked?(gain==1.0?ink.rgb:max(vec3(0),ink.rgb-glow)*gain+glow):ink.rgb*gain+glow;
  rgb=clamp(rgb,0.0,1.0);
  vec3 mark=vec3(0);
  ${u?"if(!u_index)rgb=waterPaint(rgb,gl_FragCoord.xy,u_surfaceViewport,axial,mark);":""}
  ${p?.media?"if(!u_index)rgb=envMedia(rgb,gl_FragCoord.xy,u_surfaceViewport,axial);":""}
  rgb=mix(rgb,u_fog,fog);
  ${m?"rgb=mix(rgb,u_sectionEdge.rgb,sectionInk(margin));":""}
  color=u_filterMatte?vec4(vec3(u_filterSoftness),1):u_index?vec4(float(u_portalCover)):vec4(rgb,1);
  depth=vec4(d,0,0,1);
  water=vec4(mark,1);
  ${_?"splitOpaqueSurface(color,z);":""}
  if(u_index&&u_graphDepth){
    float packedDepth=round(d*16777215.0);
    water=vec4(mod(packedDepth,256.0),mod(floor(packedDepth/256.0),256.0),floor(packedDepth/65536.0),255.0)/255.0;
  }
}`);return r.set(w,y),y}return{draw(u,m){let{view:p,projection:_,eye:w,back:y,ortho:F,sun:T,artScale:f,range:x,fog:E,width:R,height:C,wet:V,water:q,environment:g,section:b,index:z,graphDepth:v,anchors:A,coverageFilter:I,glassLayers:ae,portalCover:W,arrivalPlane:Z,clip:S}=m,k=n(V,b,g,ae);e.useProgram(k.p),e.bindVertexArray(l),e.activeTexture(e.TEXTURE0+pl),k.set({u_sprite:pl,u_view:p,u_proj:_,u_eye:w,u_back:y,u_ortho:F,u_sun:T?.direction??[0,1,0],u_sunGain:T?[T.ambient,T.intensity]:[1,0],u_artScale:f,u_range:x,u_fog:E,u_surfaceViewport:[R,C],u_index:!!z,u_markPass:!!A,u_filterMatte:!!I,u_glassBoundary:13,u_graphDepth:!!v,u_portalCover:!!W,u_arrivalPlane:Z,u_splatPlane:S,...q,...b,...g?.uniforms});for(let M of u){let{placement:K,view:P,at:L,axes:N,normalAxes:H,phase:pe,step:de,cutoutLevel:ye}=M,Y=K.atlas.cutoutImage?.(P,ye),D=Y??t.tile(M);d(D),k.set({u_anchor:L,u_right:N.right,u_up:N.up,u_plane:N.normal,u_size:[P.rect.width,P.rect.height],u_pivot:[P.pivot.x,P.pivot.y],u_units:P.unitsPerPixel*K.scale,u_scale:K.scale,u_phase:pe,u_filterSoftness:I?.at(K.material)??1,u_step:de,u_depth:K.depth,u_normal:!!T&&K.lighting,u_emission:K.emission,u_baked:K.atlas.emissionMode==="baked",u_normalAxes:[...H.right,...H.up,...H.normal],u_effect:!1,u_effectDepth:0}),e.drawArrays(e.TRIANGLE_STRIP,0,4);let _e=Y?K.atlas.effect(P)?.depth:D.effectDepth;_e!==void 0&&(Y&&d(t.tile(M)),k.set({u_effect:!0,u_effectDepth:_e}),e.drawArrays(e.TRIANGLE_STRIP,0,4))}e.activeTexture(e.TEXTURE0)},dispose:()=>s.dispose()}}var Np=`
float contributionAlpha(float power, float density, bool solid) {
  if (power > 0.0 || power < -4.5) return 0.0;
  float g = density * exp(power);
  return solid ? 0.99 * smoothstep(0.38, 0.62, g) : min(0.99, g);
}`,vl=e=>e?.glsl??Np,Ao=`
uniform highp sampler2D u_constraintSlots, u_constraintRows;
uniform int u_constraintDefault, u_constraintMap, u_constraintLab, u_constraintPairs;
int contributionSlot(int index) {
  int span = textureSize(u_constraintSlots, 0).x * 4;
  int slot = int(texelFetch(u_constraintSlots, ivec2((index % span) / 4, index / span), 0)[index & 3]);
  return slot > 0 ? slot : u_constraintDefault;
}
`,So=`
uniform int u_constraintMask;
vec4 maskSettings(int slot) { return texelFetch(u_constraintRows, ivec2(u_constraintMask, slot - 1), 0); }
`,jn=e=>`
flat LOOK_IO vec4 v_maskCenter;
flat LOOK_IO vec3 v_maskNormal;
flat LOOK_IO vec3 v_maskAxis;
${e?"flat LOOK_IO vec4 v_maskSecond;":""}
`,hl=e=>`
uniform vec2 u_lookViewport;
uniform mat4 u_lookProjection;
uniform float u_lookOrtho, u_lookRadius;
${e?"uniform highp sampler2D u_maskTextures; uniform float u_maskTime;":""}
float maskAt(int slot) {
  vec4 settings = maskSettings(slot);
  if (settings.x == 0.0) return 1.0;
  vec2 screen = (gl_FragCoord.xy * 2.0 / u_lookViewport - 1.0) /
    vec2(u_lookProjection[0][0], u_lookProjection[1][1]);
  vec3 center = v_maskCenter.xyz;
  vec3 ray = vec3(u_lookOrtho > 0.5 ? vec2(0.0) : screen, -1.0);
  vec3 at = vec3(screen * (u_lookOrtho > 0.5 ? 1.0 : -center.z), center.z);
  float facing = dot(v_maskNormal, ray);
  vec3 offset = vec3(0.0);
  if (abs(facing) > 1e-7) {
    float advance = dot(v_maskNormal, center - at) / facing;
    if (abs(advance) <= u_lookRadius && -center.z + advance > 0.0)
      offset = at + advance * ray - center;
  }
  vec4 limits = texelFetch(u_constraintRows, ivec2(u_constraintMask + 2, slot - 1), 0);
  float scalar = v_maskCenter.w + dot(v_maskAxis, offset);
  ${e?`if (settings.x == 2.0) {
    vec2 uv = vec2(scalar,v_maskSecond.w + dot(v_maskSecond.xyz,offset));
    if (limits.w == 0.0 && (any(lessThan(uv,vec2(0))) || any(greaterThanEqual(uv,vec2(1))))) scalar=0.0;
    else {
      vec4 dim=texelFetch(u_constraintRows,ivec2(u_constraintMask+4,slot-1),0);
      bool repeat=texelFetch(u_constraintRows,ivec2(u_constraintMask+5,slot-1),0).x > 0.0;
      int frame=int(max(0.0,floor(u_maskTime*dim.w)));
      frame=repeat ? frame%int(dim.z) : min(frame,int(dim.z)-1);
      ivec2 pixel=ivec2(floor(fract(uv)*dim.xy));
      int at=int(limits.z)+(frame*int(dim.y)+pixel.y)*int(dim.x)+pixel.x;
      int width=textureSize(u_maskTextures,0).x;
      scalar=texelFetch(u_maskTextures,ivec2(at%width,at/width),0).r;
    }
  }`:""}
  float f = clamp((scalar - limits.x) * limits.y, 0.0, 1.0);
  if (settings.z == 1.0) f = f * f * (3.0 - 2.0 * f);
  if (settings.z == 2.0) f = step(1.0, f);
  return settings.w > 0.0 ? 1.0 - f : f;
}
`,ml=e=>`
uniform highp sampler2D u_lookSites;
void placeMask(int index, int slot, vec3 posed, vec3 viewCenter, mat3 worldToRest, mat3 view) {
  v_maskCenter = vec4(viewCenter, 0.0);
  v_maskNormal = vec3(0.0);
  v_maskAxis = vec3(0.0);
  ${e?"v_maskSecond = vec4(0.0);":""}
  if (slot == 0) return;
  vec4 settings = maskSettings(slot);
  if (settings.x == 0.0) return;
  ivec2 uv = ivec2((index & 511) * 2, index >> 9);
  vec3 normal = texelFetch(u_lookSites, uv, 0).xyz;
  vec3 rest = texelFetch(u_lookSites, uv + ivec2(1,0), 0).xyz;
  vec4 axis = texelFetch(u_constraintRows, ivec2(u_constraintMask + 1, slot - 1), 0);
  v_maskNormal = view * transpose(worldToRest) * normal;
  v_maskAxis = view * (settings.y > 0.0 ? transpose(worldToRest) * axis.xyz : axis.xyz);
  vec3 point=settings.y > 0.0 ? rest : posed;
  v_maskCenter.w = dot(point, axis.xyz) + axis.w;
  ${e?`if (settings.x == 2.0) {
    vec4 second=texelFetch(u_constraintRows,ivec2(u_constraintMask+3,slot-1),0);
    v_maskSecond=vec4(view*(settings.y > 0.0 ? transpose(worldToRest)*second.xyz : second.xyz),dot(point,second.xyz)+second.w);
  }`:""}
}
`,_l=`
    float m = floor(maskAt(v_policySlot) * 65535.0 + 0.5);
    od = vec4(mod(m,256.0), floor(m/256.0), 0.0, 255.0) / 255.0;
`;var Nt=64,xl=`
vec3 axialPosition(vec2 pixel, float axial, vec2 size) {
  vec2 screen = (pixel * 2.0 / size - 1.0) / vec2(u_proj[0][0], u_proj[1][1]);
  return vec3(screen * (u_ortho > 0.5 ? 1.0 : axial), -axial);
}`,yl=`
float pixelStyleThreshold(int mode, ivec2 p) {
  const float ordered[16] = float[16](0.0,8.0,2.0,10.0,12.0,4.0,14.0,6.0,3.0,11.0,1.0,9.0,15.0,7.0,13.0,5.0);
  if (mode == 1) return (ordered[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0;
  if (mode == 2) return ((p.x + p.y) & 1) != 0 ? 0.75 : 0.25;
  return (float((p.x + p.y) & 3) + 0.5) / 4.0;
}
`,qn=`
uniform highp sampler2D u_relight;
vec4 relightAt(int row) { return texelFetch(u_relight, ivec2(row & 511, row >> 9), 0); }
`;function Xn(e,t,{water:o=!1,airPockets:s=!1,layered:i=!1,atlas:r=!1,portal:c=!1,instances:l=!1,contributions:d=!1,masked:n=!1,textured:u=!1,layeredGlass:m=!1,coverageRules:p,materialStyles:_=!1,environment:w=!1,emitterFog:y=!1,relighting:F=!1,optical:T=!1,stableDetail:f,cutaway:x,airflow:E,footprints:R=!1,footprintGLSL:C,engraving:V=!1,marks:q=!1,screenPrintGLSL:g,spriteReconstruction:b,facingColors:z=!1,gaussianDegree:v,splatPaint:A=!1,gaussianProxy:I=!1,coverageVote:ae=!1,coverageFilter:W=!1,gaussianMaterials:Z=!1,surfaceOrder:S=!1,depthMeshProxy:k=!1}={}){if(R&&typeof C!="string")throw new Error("Footprint shaders need SplatFootprints.glsl");let M=p?.coverageStride??4,K=p?.continuousCoverage??1,P=p?.softCoverage??2,L=p?.nonSurface??2559,N=p?.continuousVariance??.25,H=p?.continuousLow??.16,pe=p?.continuousHigh??.3,de=R?`if(u_idx>3.5){
    if(!footprintPlane||v_coverage==${P}||v_color.a<1.0||g<0.5${T?"||hasOptical":""})discard;
    o=vec4(0.0);od=vec4(0.0);oa=vec4(0.0);return;
  }`:"",ye=`#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_data;
${z?z.splatVertexGLSL:""}
${v!==void 0?yo(v):""}
${Z?su:""}
${S?yu:""}
${I?qc:""}
${b?"uniform highp sampler2D u_spriteLod; uniform int u_spriteLodCount; flat out int v_spriteLod;":""}
uniform mat4 u_view, u_proj;
uniform bool u_geometryDepth;
uniform vec2 u_viewport;
uniform float u_focal, u_time, u_scale, u_snap, u_dilate, u_near, u_ortho, u_idx;
uniform bool u_motionCadence, u_motionWind;
uniform vec4 u_effectTimes, u_effectWind;
uniform vec2 u_waterAndRainTime, u_rainWind; uniform float u_emissiveWind;
${E?.glsl??""}
uniform float u_paintMarker; uniform int u_afterimageStart; flat out int v_paint;
${A?"uniform highp sampler2D u_splatPaintRows; uniform bool u_splatPaintPass; uniform int u_splatPaintCount;":""}
uniform int u_splatCoverage; uniform float u_materialGridScale; flat out int v_coverage;
${f?`uniform vec2 u_detailTexture, u_detailGeometry;
flat out float v_detailGeometry, v_detailTexture;
${f.glsl}`:""}
${F?qn+"flat out vec4 v_relight;":""}
${m?"uniform float u_glassTolerance; flat out float v_glassNearDepth;":""}
${T?`uniform highp sampler2D u_optical;
flat out vec4 v_optical;
flat out vec3 v_scatterTint, v_reflectTint;
flat out float v_opticalFog;`:""}
uniform vec4 u_actor; uniform float u_reveal, u_fade; uniform vec3 u_camdir; uniform ivec2 u_dyn;
uniform vec4 u_rev, u_rbox;   // the lit part of the world: centre x, z, sin and cos of the view's turn; then near, far, near half-width, far half-width
uniform vec4 u_sh[16]; uniform int u_shn;
uniform vec4 u_wc[4]; uniform vec4 u_wd[4];   // where a blow is about to land: painted on the ground itself (a disc that fills, or a lane), so grass cannot hide it
uniform vec4 u_hitf[4]; uniform vec3 u_fl[8];   // places just struck (a ball each), and bodies just hurt (a run of splats each): both go white for an instant
uniform highp sampler2D u_eco; uniform highp sampler2D u_bones; uniform float u_ecoOn;   // what the ground remembers, a texel to each unit of it: burnt, burning, frozen, and how high the ground is there   // round shadows: x, z, ground height, radius
uniform vec2 u_season;   // how far autumn, and how far winter, has come
${t?`uniform float u_sampleWithdrawal;
`+t.glsl:""}
uniform vec4 u_born;   // growth you can watch: when the diorama was shown, how fast its clock runs, how long a dab takes to grow, and the loop (0: once)
uniform vec2 u_cut;       // how wide a view is cleared between you and the eye, and how low it reaches
uniform float u_wl, u_slice; uniform vec2 u_lid; uniform vec4 u_pit; uniform vec4 u_portal; uniform vec2 u_pdoor; uniform vec3 u_eye;   // a doorway standing square to z (centre x, sill y, z, and which side of it this place is on), its half-width and height, and where the eye is
uniform vec3 u_fog;
uniform vec4 u_arrivalPlane;
uniform vec4 u_fogp;   // haze start, haze max, depth range near, depth range far
layout(location=0) in vec2 a_corner;
layout(location=1) in int a_index;
${l?"layout(location=2) in int a_instance; uniform highp sampler2D u_instances;":""}
${R?"uniform highp sampler2D u_footprintRows,u_footprintParams; flat out vec4 v_footprintMap; flat out vec2 v_footprintStyle, v_footprintZ; flat out vec4 v_footprintPlane;":""}
out vec2 v_d; out vec3 v_conic; out vec4 v_color; out float v_depth;
${c?"flat out vec3 v_portalDepth;":""}
${!c||m||k?"flat out float v_ownerDepth;":""}
${x?"flat out vec4 v_sectionSample;":""}
out float v_gl; out float v_as; out float v_ast; uniform vec4 u_az[4]; uniform int u_azn; uniform float u_asoft, u_azst;
${o&&!c?"flat out float v_waterAxial;":""}
${w?"flat out float v_envAxial;":""}
${e?e.vsDecl:""}// Inked detail (an option, off unless asked for): a dab may carry a 4 by 4 picture of the surface under it. Its two half-axes are
// carried to the screen here and turned inside out, so each pixel can find where on the surface it is looking.
uniform highp sampler2D u_fine; uniform float u_fineOn;
// Carried lights (the game's lantern, things on fire): where each is and how far it reaches, how strong, the palette, and for each palette
// colour the next lighter one of its own family. What is near a light steps up its own colours; nothing is tinted.
uniform vec4 u_lamp[8]; uniform float u_lamps[8]; uniform int u_lampN; uniform float u_lampGain; uniform vec3 u_lpal[${Nt}]; uniform int u_lup[${Nt}];
flat out vec4 v_fm; flat out vec4 v_ft; flat out float v_fk; flat out float v_lit; flat out float v_ix;
${d||n?`${Ao}flat out int v_policySlot;`:""}
${n?So+jn(u).replaceAll("LOOK_IO","out")+ml(u):""}
${_?"uniform highp sampler2D u_materialStyles; uniform bool u_materialPatterned, u_materialStylesOn; flat out vec4 v_pixelStyle; flat out float v_pixelFog;":""}
${V?Hu:""}
${q?Eu:""}
void main(){
  int record = a_index;
  ${l?`ivec2 inst = ivec2((a_instance & 15) * 16, a_instance >> 4);
  vec4 meta;
  if (a_instance != 0) {
    meta = texelFetch(u_instances, inst + ivec2(3, 0), 0);
    record += int(meta.x);
  }`:""}
  int row = record >> 9, col = (record & 511) << 2; v_ix = float(a_index);
  ${b?`v_spriteLod=a_index<u_spriteLodCount
    ? int(texelFetch(u_spriteLod,ivec2((a_index&511)>>2,a_index>>9),0)[a_index&3]) : 0;`:""}
  ${I?`
  int proxyIndex=a_index;
  v_gaussianProxy=proxyIndex<u_gaussianProxyCount
    ? int(texelFetch(u_gaussianProxyRows,ivec2((proxyIndex>>2)&511,proxyIndex>>11),0)[proxyIndex&3]) : 0;
  if (v_gaussianProxy<0) { gl_Position=vec4(2,2,2,1); return; }
  `:""}
  vec4 t0 = texelFetch(u_data, ivec2(col, row), 0);
  vec4 t1 = texelFetch(u_data, ivec2(col + 1, row), 0);
  vec4 t2 = texelFetch(u_data, ivec2(col + 2, row), 0);
  vec4 t3 = ${l?"a_instance != 0 ? vec4(0.0) : ":""}texelFetch(u_data, ivec2(col + 3, row), 0);
  v_paint = (u_paintMarker != 0.0 && t3.z == u_paintMarker ||
    u_afterimageStart > 0 && a_index >= u_afterimageStart) ? 1 : 0;
  ${A?`if (u_splatPaintPass) {
    int index = a_index;
    v_paint = index < u_splatPaintCount ?
      int(texelFetch(u_splatPaintRows, ivec2((index >> 2) & 511, index >> 11), 0)[index & 3]) : 0;
  }`:""}
  ${_?"v_pixelStyle = texelFetch(u_materialStyles, ivec2(record & 511, row), 0);":""}
  ${R?`
  vec4 brush0=texelFetch(u_footprintRows,ivec2((record & 511)*2,row),0);
  vec4 brush1=texelFetch(u_footprintRows,ivec2((record & 511)*2+1,row),0);
  float footprintId=brush0.x;
  bool surfaceBrush=brush1.w>0.5;
  vec2 brushU=vec2(0.0),brushV=vec2(0.0);
  bool hasFootprint=footprintId>0.0;
  vec4 footprintMap=hasFootprint?texelFetch(u_footprintParams,ivec2(int(footprintId)-1,0),0):vec4(0.0);
  vec4 footprintSettings=hasFootprint?texelFetch(u_footprintParams,ivec2(int(footprintId)-1,1),0):vec4(0.0);
  v_footprintStyle=vec2(footprintId,footprintSettings.x);
  `:""}
  vec3 pos = t0.xyz; float alpha = t0.w;
  if (alpha <= 0.0 || pos.y < -30.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // (what is put away is put far below: it is not drawn from there)
  mat3 cov = mat3(t1.x, t1.y, t1.z,  t1.y, t2.x, t2.y,  t1.z, t2.y, t2.z);
  ${l?`if (a_instance != 0) {
    int options = int(meta.w);
    if ((options & 2) != 0) {
      vec4 cut = texelFetch(u_instances, inst + ivec2(4, 0), 0);
      vec3 delta = pos - cut.xyz;
      if (dot(delta, delta) <= cut.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    }
    if ((options & 1) != 0) {
      vec4 axis = texelFetch(u_instances, inst + ivec2(13, 0), 0);
      pos = pos * axis.w + axis.xyz;
      cov *= axis.w * axis.w;
    } else {
      vec4 a = texelFetch(u_instances, inst, 0);
      vec4 b = texelFetch(u_instances, inst + ivec2(1, 0), 0);
      vec4 c = texelFetch(u_instances, inst + ivec2(2, 0), 0);
      mat3 transform = transpose(mat3(a.xyz, b.xyz, c.xyz));
      pos = transform * pos + vec3(a.w, b.w, c.w);
      cov = transform * cov * transpose(transform);
    }
    if (pos.y < -30.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    alpha *= meta.z;
    ${_?"float originalShade = t1.w; vec2 originalRamp = v_pixelStyle.zw;":""}
    if (meta.y > 0.0) for (int i = 0; i < 16; i++) {
      if (i >= int(meta.y)) break;
      vec4 pair = texelFetch(u_instances, inst + ivec2(5 + i / 2, 0), 0);
      vec2 swap = i % 2 == 0 ? pair.xy : pair.zw;
      ${_?`
      if (originalShade == swap.x) t1.w = swap.y;
      if (originalRamp.x == swap.x) v_pixelStyle.z = swap.y;
      if (originalRamp.y == swap.x) v_pixelStyle.w = swap.y;`:"if (t1.w == swap.x) { t1.w = swap.y; break; }"}
    }
  }`:""}
  vec3 color = vec3(mod(t1.w, 256.0), mod(floor(t1.w / 256.0), 256.0), floor(t1.w / 65536.0)) / 255.0;
  vec3 color0 = color; mat3 FM = mat3(1.0); v_fk = -1.0; v_lit = 0.0; v_fm = vec4(0.0); v_ft = vec4(0.0);
  int kraw = int(t2.w), flags = kraw / 16, kind = kraw - flags * 16;
  ${t?"if (!sampleCoverageVisible(kraw, u_sampleWithdrawal)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }":""}
  float ph = t3.x, sp = t3.y, rg = t3.z, ex = t3.w, sc = u_scale;
  bool snap = false, stat = a_index < u_dyn.x || a_index >= u_dyn.y, pv = (flags & 8) != 0, green = (flags & 2) == 0 && color.g - max(color.r, color.b) > 0.06, veg = green || (flags & 6) == 0 && color.b - color.g > 0.15 && color.r - color.g > 0.08, fire = false;   // what grows: green things, and the purple grass
  if (u_ecoOn > 0.5 && stat && !pv && abs(t0.x) < 80.0 && t0.z > -208.0 && t0.z < 80.0) {
    vec4 eco = texelFetch(u_eco, ivec2(clamp(floor(t0.xz) + vec2(80.0, 208.0), vec2(0.0), vec2(159.0, 287.0))), 0);
    float hb = fract(sin(dot(floor(t0.xyz / 0.4), vec3(27.1, 61.7, 13.3))) * 4375.85), up = t0.y - (eco.a * 25.5 - 8.0);
    if ((flags & 4) != 0) { if (eco.b > hb * 0.8 + 0.1) { float h2 = fract(hb * 17.3), lm = dot(color, vec3(0.3, 0.59, 0.11)); kind = 0;   // water under frost: ice, still, with pale cracks in it
        color = h2 < 0.1 ? vec3(0.54, 0.52, 0.58) : lm < 0.34 || h2 < 0.7 ? vec3(0.56, 0.77, 0.96) : vec3(0.96, 0.95, 0.92); } }
    else if (eco.g > 0.9 && veg) { float fl = fract(hb * 7.0 + u_time * (2.0 + hb * 3.0)); fire = true; flags = flags | 2;   // alight
      color = fl < 0.33 ? vec3(1.0, 0.82, 0.29) : fl < 0.7 ? vec3(0.94, 0.54, 0.14) : vec3(0.72, 0.31, 0.10); }
    else if (eco.r > hb * 0.9 + 0.05 && (flags & 2) == 0) {   // burnt: leaves are gone, grass is black stubble, and everything else there is sooted
      if (veg) { if (up > 1.1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } veg = false; green = false; sc *= 0.72;
        color = eco.g > 0.1 && fract(hb * 13.0 + u_time * 0.7) < 0.12 ? vec3(0.94, 0.54, 0.14) : hb < 0.5 ? vec3(0.07, 0.06, 0.07) : vec3(0.17, 0.13, 0.12); }
      else color *= 0.5; }
    else if (veg && eco.b > hb * 0.8 + 0.1 && up < 1.2) { float lm = dot(color, vec3(0.3, 0.59, 0.11)); veg = false; green = false; color = lm < 0.45 ? vec3(0.54, 0.52, 0.58) : lm < 0.62 ? vec3(0.56, 0.77, 0.96) : vec3(0.96, 0.95, 0.92); }   // rime on the grass
  }
  bool fabric = (kraw & 6144) == 4096;
  float foliageTime = u_motionCadence ? u_effectTimes.x : u_time;
  float bendTime = fabric && u_motionCadence ? u_effectTimes.y : foliageTime;
  float fallTime = u_motionCadence ? ((kraw & 8192) != 0 ? u_waterAndRainTime.y : u_effectTimes.z) : u_time;
  float flickerTime = u_motionCadence ? u_effectTimes.w : u_time;
  float waterTime = u_motionCadence ? u_waterAndRainTime.x : u_time;
  if (kind == 1) { alpha *= 0.62 + 0.38 * sin(flickerTime * sp + ph); snap = u_snap > 0.5; }                      // twinkle
  else if (kind == 2) { float pr = fract(fallTime * sp / rg + ph); pos.y -= pr * rg; alpha *= 1.0 - pr * pr; sc *= 1.0 + pr * ex;
    pos.xz += u_rainWind * (pr * rg / max(sp, 0.00001)); }   // fall
  else if (kind == 3) { float pr = fract(u_time * sp / rg + ph); pos.y += pr * rg; pos.x += sin(pr * 7.0 + ph * 50.0) * 0.25 * pr;
                        alpha *= (1.0 - pr) * smoothstep(0.0, 0.1, pr); sc *= 0.6 + pr * ex; }                 // rise
  else if (kind == 4) { color += vec3(0.3) * smoothstep(0.75, 1.0, sin(waterTime * sp + ph)); }                   // shimmer
  else if (kind == 5) { float a = u_time * sp, c = cos(a), s = sin(a);
                        mat3 R = mat3(c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c); pos = R * pos; cov = R * cov * transpose(R); FM = R; } // orbit
  else if (kind == 6) { pos.y += sin(u_time * sp + ph) * rg; }                                                 // bob
  else if (kind == 7) { alpha *= 0.82 + 0.18 * sin(flickerTime * sp + ph); }                                        // glow
  else if (kind == 8) { float f = 0.2 + 0.8 * abs(sin(u_time * sp + ph)); pos.x = rg + (pos.x - rg) * f; pos.z = ex + (pos.z - ex) * f; pos.y += 0.14 * sin(u_time * sp * 0.31 + ph); }   // flap about a pivot
  else if (kind == 9) { pos.xz *= 1.0 + rg * sin(u_time * sp + ph - pos.y * ex); }                                                         // swell about the centre line
  else if (kind == 10) { float q = length(pos.xz), w = min(1.0, q * 0.22); pos.y += rg * w * sin(u_time * sp + ph - q * ex);
                         pos.xz += rg * 0.6 * w * vec2(-pos.z, pos.x) / max(q, 0.01) * sin(u_time * sp * 0.7 + ph - q * ex * 0.6); }                 // writhe outward from the centre
  else if (kind == 11) {
    ${E?"if (u_motionWind && (kraw & 8192) != 0) pos.xz += (fabric ? u_effectWind.zw : u_effectWind.xy) * airflowBend(bendTime, ph, sp, rg); else":""}
    { pos.x += rg * sin(bendTime * sp + pos.y * 1.3 + pos.z * 0.9 + ph); pos.y += rg * 0.6 * sin(bendTime * sp * 1.3 + pos.x * 1.1 + ph); }
    vec2 dv = pos.xz - u_actor.xy; float q = length(dv); if (u_actor.z > 0.0 && q < u_actor.z && pos.y - u_actor.w < 2.3 && pos.y - u_actor.w > -0.4) { float pf = 1.0 - q / u_actor.z; pos.xz += dv / max(q, 0.05) * pf * pf * 0.5; pos.y -= pf * pf * 0.07; } }
  else if (kind == 12 || kind == 13) { int bi = int(ph + 0.5) * 3; ivec2 bq = ivec2(bi % 768, bi / 768); vec4 b0 = texelFetch(u_bones, bq, 0), b1 = texelFetch(u_bones, bq + ivec2(1, 0), 0), b2 = texelFetch(u_bones, bq + ivec2(2, 0), 0);   // carried by a bone: the splat is kept as it was made, and turned and moved here
                         mat3 A = mat3(b0.x, b1.x, b2.x, b0.y, b1.y, b2.y, b0.z, b1.z, b2.z); vec3 p1 = A * pos + vec3(b0.w, b1.w, b2.w); cov = A * cov * transpose(A); FM = A;
                         if (rg > 0.0) { int ci = int(sp + 0.5) * 3; ivec2 cq = ivec2(ci % 768, ci / 768); vec4 c0 = texelFetch(u_bones, cq, 0), c1 = texelFetch(u_bones, cq + ivec2(1, 0), 0), c2 = texelFetch(u_bones, cq + ivec2(2, 0), 0);   // shared with a second bone: its place is blended
                           p1 = mix(p1, vec3(dot(c0.xyz, pos) + c0.w, dot(c1.xyz, pos) + c1.w, dot(c2.xyz, pos) + c2.w), rg); }
                         pos = p1;
                         if (kind == 13) { pos.x += 0.022 * sin(foliageTime * 1.9 + pos.y * 1.3 + pos.z * 0.9 + 1.0); pos.y += 0.0132 * sin(foliageTime * 2.47 + pos.x * 1.1 + 1.0); } }   /* carried, and then stirred by the wind as hair and grass are */
  else if (kind == 15) { float pr = fract(foliageTime * sp / rg + ph); pos.y -= pr * rg; pos.x += sin(pr * 11.0 + ph * 40.0) * ex; pos.z += cos(pr * 7.0 + ph * 23.0) * ex * 0.6;   // flutter down: a leaf or a flake, swinging as it falls
                         alpha *= smoothstep(0.0, 0.05, pr) * (1.0 - smoothstep(0.92, 1.0, pr)); }
  else if (kind == 14) { float hg = max(0.0, pos.y - ex); pos.x += rg * hg * sin(foliageTime * sp + ph); pos.z += rg * 0.6 * hg * sin(foliageTime * sp * 0.73 + ph * 1.7); }   // sways as a whole from its foot (a placed copy: ex is where its foot is)
  if ((flags & 2) != 0 && (kind == 1 || (kind == 7 && ex != -7.0))) alpha *= 1.0 - u_emissiveWind;
  if ((flags & 32) != 0) { float gt = (u_time - u_born.x) * u_born.y; if (u_born.w > 0.0) gt = mod(gt, u_born.w); float gs = clamp((gt - ex) / u_born.z, 0.0, 1.0);   // born: not there till its time, then it grows to its size
                           if (gs <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } sc *= gs * (2.0 - gs); }
  else if ((flags & 64) != 0) { float wt = clamp(((u_time - u_born.x) * u_born.y - ex) / 2.0, 0.0, 1.0); color = mix(color, color * vec3(0.58, 0.62, 0.7), wt); }   // wet: from its time on it darkens, as rain soaks it
  // The portal is not a picture. A piece of the other place really stands beyond the ring; of it, only what the eye sees through the
  // ring is drawn, and of this place, whatever lies beyond the ring on that same line of sight is left out.
  if (u_portal.w != 0.0) { bool thr = false; float sg = u_portal.w;
    if ((pos.z - u_portal.z) * sg < -0.12 && (u_eye.z - u_portal.z) * sg > 0.05) { vec3 hp = u_eye + (pos - u_eye) * ((u_eye.z - u_portal.z) / (u_eye.z - pos.z)); thr = abs(hp.x - u_portal.x) < u_pdoor.x && hp.y > u_portal.y && hp.y < u_portal.y + u_pdoor.y; }
    if (pv ? !thr : (thr && stat)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } }
  else if (pv) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  ${c?"":"if (dot(u_arrivalPlane, vec4(pos, 1.0)) < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }"}
  // under a roof, the storey over your head is not drawn at all: the cut comes down from above to just over head height, block by block
  if (u_lid.y > 0.0 && !pv) { float hl = fract(sin(dot(floor(pos.xyz / 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453); if (pos.y > u_lid.x + (stat ? 0.0 : 0.9) + (1.0 - u_lid.y) * (7.0 + 3.0 * hl)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } }
  // what moves (an enemy, a barrel, a saw, a rail's lights) is held to the same lit circle as the ground it stands on: nothing shows out in the black where there is no floor
  if (u_reveal > 0.0 && !stat && !pv && u_rbox.x > 0.5) { float hv2 = fract(sin(dot(floor(pos.xyz / 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453); if (clamp((u_rbox.x - distance(pos.xz, u_rev.xy)) / 2.2, 0.0, 1.0) <= hv2 * 0.86 + 0.04) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } }
  if (u_reveal > 0.0 && stat) {
    // The world exists only around you. Scenery stays exactly where it stands and comes up out of black, patch by patch:
    // when its cell arrives, and again at the edge of the lit ground, which trails a little behind as you run.
    // It forms in solid half-unit blocks, not as loose specks: every splat in a block appears at the same moment, low blocks before
    // high ones, so a tree arrives trunk first and its crown in clumps.
    float hv = fract(sin(dot(floor(t0.xyz / 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453), hs = fract(float(a_index) * 0.6180339), yr = clamp(t0.y - u_actor.w, 0.0, 9.0);
    float de = pv ? 9.0 : u_rbox.x - distance(pos.xz, u_rev.xy) - (1.0 - u_fade) * 50.0;   // how far inside the circle of world round you this is
    bool own = kind == 2 || kind == 3 || kind == 8 || kind == 9 || kind == 10 || kind == 14 || kind == 15;   // these use the last number for their own motion, so they carry no arrival time
    float te = min(clamp((de - yr * 0.1) / 2.2, 0.0, 1.0), own ? 1.0 : clamp((u_time - ex) / 0.7 - yr * 0.06, 0.0, 1.0));
    if (te <= hv * 0.86 + 0.04) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // not formed yet: nothing is drawn, so what shows is plain black
    // seasons: everything green turns, a patch at a time: to amber and rust in autumn, to snow in winter
    if (green && !fire && u_season.x + u_season.y > 0.0) {
      float lm = dot(color, vec3(0.3, 0.59, 0.11)), hp = fract(sin(dot(floor(pos.xz / 0.7), vec2(41.3, 17.7))) * 9731.1) * 0.999;
      if (hp < u_season.y) color = lm < 0.3 ? vec3(0.34, 0.31, 0.42) : lm < 0.45 ? vec3(0.54, 0.52, 0.58) : lm < 0.62 ? vec3(0.56, 0.77, 0.96) : vec3(0.96, 0.95, 0.92);
      else if (hp < u_season.x) color = lm < 0.3 ? vec3(0.42, 0.27, 0.15) : lm < 0.45 ? vec3(0.72, 0.31, 0.10) : lm < 0.62 ? vec3(0.94, 0.54, 0.14) : vec3(1.0, 0.82, 0.29);
    }
    // round shadows under whoever is standing on this
    if ((flags & 6) == 0) for (int i = 0; i < 16; i++) { if (i >= u_shn) break; vec4 s4 = u_sh[i]; if (distance(pos.xz, s4.xy) < s4.w && pos.y > s4.z - 0.35 && pos.y < s4.z + 0.55) {   // the shadow is a darker colour of the same family, never a tint that lands on some other hue
      float lm = dot(color, vec3(0.3, 0.59, 0.11)); color = color.g - max(color.r, color.b) > 0.06 ? (lm > 0.62 ? vec3(0.227, 0.478, 0.235) : vec3(0.118, 0.29, 0.204)) : color * 0.45; break; } }
    for (int i = 0; i < 4; i++) { vec4 wc = u_wc[i], wd = u_wd[i]; if (wc.w > 0.0 && abs(pos.y - wc.y - 0.35) < 1.2) { vec2 ab = wd.zw - wc.xz; float tt = wd.y < 0.5 ? 0.0 : clamp(dot(pos.xz - wc.xz, ab) / max(dot(ab, ab), 0.001), 0.0, 1.0), dd = distance(pos.xz, wc.xz + ab * tt);
      if (dd < wc.w) { bool rim = dd > wc.w - 0.2 || (wd.y > 0.5 && (tt < 0.02 || tt > 0.98)), fill = wd.y < 0.5 ? dd < wc.w * wd.x : tt < wd.x; color = rim ? vec3(1.0, 0.64, 0.3) : mix(color, vec3(0.84, 0.17, 0.15), fill ? 0.62 : 0.26); } } }
    // whatever stands between you and the eye is simply not drawn
    vec3 rel = pos - vec3(u_actor.x, u_actor.w + 0.9, u_actor.y); float al = dot(rel, u_camdir), pr2 = length(rel - al * u_camdir);
    vec2 hc = normalize(u_camdir.xz + vec2(0.0, 1e-5));   // (only what is on the eye's side of you: a wall you have your back to is behind you however tall it is, and stays whole)
    if (al > 0.4 && dot(rel.xz, hc) > 0.2 + 0.25 * hs && pos.y > u_actor.w + u_cut.y && pr2 < u_cut.x - 0.4 * hs) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // and, underground, whatever stands well to the eye's side of you is cut down to knee height right across: the back of the next
    // room's wall, its railings and its statues would otherwise fill the bottom of the picture
    if (u_slice > 0.0 && dot(rel.xz, hc) > u_slice + 0.8 * hv && pos.y > u_actor.w + u_cut.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // What lies under the water (a reflection, the bed) is seen only through water: the line from the eye to it has to cross the
    // surface where there is water, inside the lit circle. Otherwise it would hang in the dark under the edge of the world.
    // And a reflection goes when the thing it is the reflection of has been cut away.
    if (!pv && pos.y < u_wl - 0.02 && u_eye.y > u_wl + 0.1 && !(pos.x > u_pit.x && pos.x < u_pit.y && pos.z > u_pit.z && pos.z < u_pit.w)) { vec3 dd = pos - u_eye; vec2 q = u_eye.xz + dd.xz * ((u_wl - u_eye.y) / dd.y);
      if (distance(q, u_rev.xy) > u_rbox.x - 0.3 || (u_ecoOn > 0.5 && texelFetch(u_eco, ivec2(clamp(floor(q) + vec2(80.0, 208.0), vec2(0.0), vec2(159.0, 287.0))), 0).a * 25.5 - 8.0 > u_wl - 0.03)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
      vec3 rs = vec3(pos.x, 2.0 * u_wl - pos.y, pos.z) - vec3(u_actor.x, u_actor.w + 0.9, u_actor.y); float as2 = dot(rs, u_camdir);
      if ((flags & 1) != 0 && rs.y + 0.9 > u_cut.y && (as2 > 0.4 && length(rs - as2 * u_camdir) < u_cut.x || u_slice > 0.0 && dot(rs.xz, hc) > u_slice)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } }
  }
  cov *= sc * sc;

  vec4 cam = u_view * vec4(pos, 1.0);
  if (cam.z > -u_near) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
${o&&!c?"  v_waterAxial = -cam.z;":""}
${w?"  v_envAxial = -cam.z;":""}
  vec4 clip = u_proj * cam;
  ${S?"if (u_surfacePeel) surfaceOrderVertex(record, FM, mat3(u_view), cov, cam.xyz, (flags & 4) != 0);":""}
  ${m?`
  vec4 nearGlass = u_proj * vec4(cam.xy, min(cam.z + u_glassTolerance, -u_near), cam.w);
  v_glassNearDepth = nearGlass.z / nearGlass.w * 0.5 + 0.5;`:""}
  ${d||n?"v_policySlot = contributionSlot(a_index);":""}
  ${n?"if (u_idx < 2.5) placeMask(a_index, v_policySlot, pos, cam.xyz, abs(determinant(FM)) > 1e-8 ? inverse(FM) : mat3(1.0), mat3(u_view));":""}
  ${!c||m||k?`v_ownerDepth = ${m||k?"":"u_idx > 1.5 ? "}clip.z / clip.w * 0.5 + 0.5${m||k?"":" : 0.0"};`:""}
  ${Z?"v_gaussianMaterial = 0;":""}
  ${v!==void 0?`
  if (u_idx < 0.5 && record < u_gaussianCount${l?" && a_instance == 0":""}) {
    vec3 ray = u_ortho > 0.5 ? -vec3(u_view[0].z, u_view[1].z, u_view[2].z) : pos - u_eye;
    color = gaussianRgb(record, ray);
    ${Z?"color = shadeGaussianMaterial(record, ray, color);":""}
    color0 = color;
  }`:""}
  float dn = clamp((-cam.z - u_fogp.z) / (u_fogp.w - u_fogp.z), 0.0, 1.0);
  if (u_lampN > 0 && (flags & 22) == 0 && alpha >= 1.0) {
    float tr = cov[0][0] + cov[1][1] + cov[2][2], pp = tr / 2.4253, add = 0.0;   // (a dab is a disc, thin the way it faces: from its shape, how squarely it faces a light)
    for (int i = 0; i < 8; i++) { if (i >= u_lampN) break; vec4 Lq = u_lamp[i]; vec3 dl = Lq.xyz - pos; float d2 = dot(dl, dl);
      if (d2 < Lq.w * Lq.w) { float fa = 1.0 - sqrt(d2) / Lq.w, nd = sqrt(clamp(dot(dl, (cov - mat3(pp)) * dl) / (-0.5747 * pp * max(d2, 1e-4)), 0.0, 1.0)); add += fa * fa * u_lamps[i] * (0.3 + 0.7 * nd); } }
    if (add > 0.0) { float hb = fract(sin(dot(floor(pos.xyz / 0.22), vec3(12.9898, 78.233, 37.719))) * 43758.5453); int steps = int(floor(add * u_lampGain + (hb - 0.5) * 0.5)); v_lit = clamp(add * 1.8, 0.0, 1.0);   // (how lit it is also goes to the last pass, which shows lit things in the colours they have by day)
      if (steps > 0) { int ci = -1; for (int k = 0; k < u_lpal.length(); k++) { vec3 dc = abs(color - u_lpal[k]); if (max(dc.r, max(dc.g, dc.b)) < 0.5 / 255.0) { ci = k; break; } }
        if (ci >= 0) { if (!stat) steps = min(steps, 1);   /* (whoever carries the light is not washed out by it) */
          for (int k = 0; k < 3; k++) { if (k >= steps) break; ci = clamp(u_lup[ci], 0, u_lpal.length() - 1); } color = u_lpal[ci]; color0 = color; } } } }
  bool plain = color == color0 && (kraw & 32768) == 0; float fogk = (flags & 2) == 0 && u_fogp.y > 0.0 && u_fogp.x < 1.0 ? smoothstep(u_fogp.x, 1.0, dn) * u_fogp.y : 0.0;   // (smoothstep from 1 to 1 is undefined: some cards give NaN, a black pixel)
  ${T?`
  ivec2 opticalUV = ivec2((a_index & 511) * 3, a_index >> 9);
  v_optical = texelFetch(u_optical, opticalUV, 0);
  v_scatterTint = texelFetch(u_optical, opticalUV + ivec2(1,0), 0).xyz;
  v_reflectTint = texelFetch(u_optical, opticalUV + ivec2(2,0), 0).xyz;
  v_opticalFog = v_optical.w > 0.5 ? fogk : 0.0;
  fogk -= v_opticalFog;`:""}
  ${F?"v_relight = relightAt(a_index); if (v_relight.w > 0.0) { v_relight.w += fogk; fogk = 0.0; }":""}
  if (fogk > 0.0) color = mix(color, u_fog, fogk);   // distance haze
  vec3 colorF = color;
  int coverage = u_splatCoverage;
  ${_?`
  int encodedCoverage = int(v_pixelStyle.x / ${M}.0);
  if (encodedCoverage > 0) coverage = encodedCoverage - 1;
  v_pixelStyle.x = mod(v_pixelStyle.x, ${M}.0);
  if (!u_materialStylesOn) v_pixelStyle.xy = vec2(0.0);`:""}
  bool continuous = coverage == ${K} && alpha >= 1.0 && (kraw & ${L}) == 0 && v_paint == 0
    ${T?"&& v_optical.w < 0.5":""}${R?" && !hasFootprint":""};
  v_coverage = continuous ? ${K} : (coverage == ${P} ? ${P} : 0);
  v_depth = coverage == ${P} || (flags & 1) != 0 ${T?"|| v_optical.w > 0.5":""} ? -1.0 : dn;
  float iz = -1.0 / cam.z;
  vec2 lim = 1.3 * 0.5 * u_viewport / u_focal;
  float tx = clamp(cam.x * iz, -lim.x, lim.x) / iz, ty = clamp(cam.y * iz, -lim.y, lim.y) / iz;
  // Jacobian of the perspective projection, then covariance into screen space
  mat3 J = u_ortho > 0.5 ? mat3(u_focal, 0.0, 0.0,   0.0, u_focal, 0.0,   0.0, 0.0, 0.0)   // (orthographic: u_focal is pixels to a unit)
    : mat3(u_focal * iz, 0.0, 0.0,   0.0, u_focal * iz, 0.0,   u_focal * tx * iz * iz, u_focal * ty * iz * iz, 0.0);
  mat3 T = J * mat3(u_view);
  ${V?Ku:""}
  ${q?Fu:""}
  mat3 c2 = T * cov * transpose(T);
  float variance = continuous ? ${N} * u_materialGridScale * u_materialGridScale : u_dilate;
  float A = c2[0][0] + variance, B = c2[0][1], C = c2[1][1] + variance;
  ${f?`
  v_detailTexture = 1.0;
  v_detailGeometry = 1.0;
  if (u_detailGeometry.y > u_detailGeometry.x && detailStroke(kraw) && v_paint == 0
      ${T?"&& v_optical.w < 0.5":""}) {
    v_detailGeometry = detailWeight(u_detailGeometry,detailGeometryPixels(c2[0][0],B,c2[1][1],u_materialGridScale));
    if (v_detailGeometry <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  }`:""}
  float det = A * C - B * B;
  if (det <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_conic = vec3(C, -B, A) / det;
  ${R?`
  v_footprintZ=vec2(cam.z,0.0);v_footprintPlane=vec4(0.0);
  if(hasFootprint){
    if(surfaceBrush){
      if(footprintSettings.z>0.5){
        vec3 frameU=mat3(u_view)*FM*brush0.yzw*sc,frameV=mat3(u_view)*FM*brush1.xyz*sc;
        vec3 normal=normalize(cross(frameU,frameV));
        v_footprintPlane=vec4(normal,dot(normal,cam.xyz));v_footprintZ.y=1.0;
      }
      brushU=(T*FM*brush0.yzw*sc).xy;brushV=(T*FM*brush1.xyz*sc).xy;
      float area=brushU.x*brushV.y-brushU.y*brushV.x;
      if(abs(area)<1e-10){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
      vec4 inv=vec4(brushV.y,-brushV.x,-brushU.y,brushU.x)/area;
      v_footprintMap=vec4(footprintMap.x*inv.x+footprintMap.y*inv.z,footprintMap.x*inv.y+footprintMap.y*inv.w,
        footprintMap.z*inv.x+footprintMap.w*inv.z,footprintMap.z*inv.y+footprintMap.w*inv.w);
    }else{
      float root=sqrt(det),den=1.1774100225154747*root*sqrt(A+C+2.0*root);
      vec3 inv=vec3(C+root,-B,A+root)/den;
      v_footprintMap=vec4(footprintMap.x*inv.x+footprintMap.y*inv.y,footprintMap.x*inv.y+footprintMap.y*inv.z,
        footprintMap.z*inv.x+footprintMap.w*inv.y,footprintMap.z*inv.y+footprintMap.w*inv.z);
    }
  }else v_footprintMap=vec4(0.0);
  `:""}
  ${c||x?`
  // Condition axial depth on pixel offset using projected Gaussian covariance.
  vec3 back = vec3(u_view[0].z, u_view[1].z, u_view[2].z);
  vec3 crossDepth = cov * back;
  vec2 depthCov = -(T * crossDepth).xy;
  `:""}
  ${c?"v_portalDepth = vec3(-cam.z, mat2(v_conic.x, v_conic.y, v_conic.y, v_conic.z) * depthCov);":""}
  ${x?`
  float pureDet = c2[0][0] * c2[1][1] - B * B;
  vec3 sectionConic = pureDet > 1e-8 * max(1.0, c2[0][0] * c2[1][1])
    ? vec3(c2[1][1], -B, c2[0][0]) / pureDet : v_conic;
  vec2 sectionSlope = mat2(sectionConic.x, sectionConic.y, sectionConic.y, sectionConic.z) * depthCov;
  v_sectionSample = vec4(-cam.z, sectionSlope, 3.0 * sqrt(max(0.0, dot(back, crossDepth))));
  `:""}
  vec2 ext = min(${R?"(hasFootprint?footprintSettings.y:3.0)":"3.0"} * sqrt(vec2(A, C)), vec2(2048.0));
  ${R?"if(hasFootprint&&surfaceBrush)ext=min(vec2(2048.0),max(ext,(abs(brushU)+abs(brushV))*footprintSettings.y/1.1774100225154747));":""}
  ${R?`if(hasFootprint&&surfaceBrush&&footprintSettings.z>0.5&&u_ortho<0.5){
    // Bound the perspective-projected physical chart, not its center Jacobian.
    vec2 middle=clip.xy/clip.w*u_viewport*0.5;
    float reach=footprintSettings.y/1.1774100225154747;
    for(int k=0;k<4;k++){
      float a=(k==0||k==3)?-1.0:1.0,b=k<2?-1.0:1.0;
      vec3 corner=cam.xyz+mat3(u_view)*FM*(brush0.yzw*a+brush1.xyz*b)*sc*reach;
      vec4 projected=u_proj*vec4(corner,1.0);
      ext=max(ext,corner.z>=-0.0001?vec2(2048.0):min(vec2(2048.0),abs(projected.xy/projected.w*u_viewport*0.5-middle)));
    }
  }`:""}
  vec2 ndc = clip.xy / clip.w;
  if (snap) { vec2 px = floor((ndc * 0.5 + 0.5) * u_viewport) + 0.5; ndc = px / u_viewport * 2.0 - 1.0; }
  vec2 extN = ext * 2.0 / u_viewport;
  if (any(greaterThan(abs(ndc) - extN, vec2(1.0)))) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_d = a_corner * ext;
  if (stat) { for (int i = 0; i < 4; i++) { vec4 h4 = u_hitf[i]; if (h4.w > 0.0 && distance(pos, h4.xyz) < h4.w) color = vec3(1.0, 0.97, 0.88); } }
  else { float ai = float(a_index); for (int i = 0; i < 8; i++) { vec3 f3 = u_fl[i]; if (f3.z > 0.0 && ai >= f3.x && ai < f3.y) color = vec3(1.0, 0.97, 0.88); } }
  if (${l?"a_instance == 0 && ":""}u_fineOn > 0.5 && plain && color == colorF) {   // (a dab that has been recoloured since it was baked, by anything, is drawn plain)
    ivec2 fq = ivec2((a_index & 511) * 3, row); vec4 f1 = texelFetch(u_fine, fq + ivec2(1, 0), 0), f2 = texelFetch(u_fine, fq + ivec2(2, 0), 0);
    if (f2.w > 0.5 && f1.w == t1.w) { vec3 pu = T * (FM * f1.xyz) * sc, pw = T * (FM * f2.xyz) * sc; float dt = pu.x * pw.y - pw.x * pu.y;
      if (abs(dt) > 1e-4 * (abs(pu.x * pw.y) + abs(pw.x * pu.y) + 1e-9)) {
        ${f?`if (u_detailTexture.y > u_detailTexture.x) v_detailTexture =
          detailWeight(u_detailTexture,detailTexturePixels(pu.xy,pw.xy,u_materialGridScale));`:""}
        v_fm = vec4(pw.y, -pw.x, -pu.y, pu.x) / dt; v_ft = texelFetch(u_fine, fq, 0); v_fk = fogk; } } }
  ${_?`
  int styleCode = int(v_pixelStyle.y);
  if (!plain || color != colorF || v_lit > 0.0 ||
      (u_materialPatterned && (styleCode & 1024) != 0) ||
      t1.w != (fract(v_pixelStyle.y) >= 0.25 ? v_pixelStyle.w : v_pixelStyle.z)) v_pixelStyle.y = 0.0;
  v_pixelFog = fogk;`:""}
  ${z?`facingVertex(color == colorF ? record : -1, FM, u_view,
    alpha >= 1.0 && v_depth >= 0.0, fogk);`:""}
  v_color = vec4(min(color, 1.0), alpha);
  v_gl = (flags & 16) != 0 ? 1.0 : 0.0;   // glass
  v_as = (flags & 128) != 0 ? 1.0 : 0.0; v_ast = v_as > 0.5 ? float(((kraw >> 12) & 1) | (((kraw >> 14) & 1) << 1)) : 0.0;   // text (K.ascii): the dab asks for it (and maybe for a set of its own), or it lies inside a zone (0.5 on the zone's surface)
  for (int i = 0; i < 4; i++) { if (i >= u_azn) break; vec4 z4 = u_az[i]; float zm = clamp(0.5 + (z4.w - distance(pos, z4.xyz)) / (2.0 * u_asoft), 0.0, 1.0); if (zm > v_as) { v_as = zm; v_ast = u_azst; } }

${e?e.vsMain:""}  gl_Position = vec4(ndc + a_corner * extN, u_geometryDepth ? clip.z/clip.w : 0.0, 1.0);
}`,Y=`#version 300 es
precision highp float; precision highp int;
${I?Vc:""}
${Z?cu:""}
${S?bu:""}
${b?`flat in int v_spriteLod; uniform vec2 u_spriteLodGrid;
${b}`:""}
${R?"uniform highp sampler2D u_footprintAtlas; uniform float u_footprintColumns; flat in vec4 v_footprintMap; flat in vec2 v_footprintStyle, v_footprintZ; flat in vec4 v_footprintPlane;":""}
in vec2 v_d; in vec3 v_conic; in vec4 v_color; in float v_depth; flat in int v_coverage;
${f?"flat in float v_detailGeometry, v_detailTexture;":""}
${c?"flat in vec3 v_portalDepth; uniform vec4 u_splatPlane, u_portalCoverPlane;":""}
${!c||m||k?"flat in float v_ownerDepth;":""}
${c||x||R?"uniform mat4 u_proj;":""}
${c||x||R||z?"uniform float u_ortho;":""}
${z?z.splatFragmentGLSL:""}
${R||z?"uniform float u_focal;":""}
${R&&!x?"uniform bool u_geometryDepth;":""}
${x?x+`
flat in vec4 v_sectionSample;
uniform mat4 u_view;
uniform vec4 u_fogp;
uniform float u_near;
uniform bool u_geometryDepth;`:""}
in float v_gl; in float v_as; in float v_ast;
${e?e.fsDecl:`uniform float u_gly;
`}uniform float u_crisp, u_hard;
flat in vec4 v_fm; flat in vec4 v_ft; flat in float v_fk; flat in float v_lit; flat in float v_ix; uniform vec3 u_fpal[${Nt}]; uniform vec3 u_fog;
${_?`flat in vec4 v_pixelStyle; flat in float v_pixelFog; uniform float u_materialGridScale;
${yl}`:""}
uniform float u_idx, u_gaussianNormalCutoff;
uniform bool u_paintPass; flat in int v_paint;
${k?"uniform highp sampler2D u_meshDepthProxy;":""}
${ae?"uniform bool u_coverageVotePass;":""}
${W?Lc:""}
${F?"flat in vec4 v_relight;":""}
${T?"flat in vec4 v_optical; flat in vec3 v_scatterTint, v_reflectTint; flat in float v_opticalFog;":""}
layout(location=0) out vec4 o;
layout(location=1) out vec4 od;
${m&&!o?"vec4 oa;":"layout(location=2) out vec4 oa;"}
${m?`layout(location=${o?3:2}) out vec4 o_back;
layout(location=${o?4:3}) out vec4 o_through;
uniform highp sampler2D u_glassBoundary;
flat in float v_glassNearDepth;
float glassDepth(vec4 sampleDepth) {
  return dot(floor(sampleDepth.rgb*255.0+0.5),vec3(1.0,256.0,65536.0)) / 16777215.0;
}`:""}
${o||c||w||x||R||z?"uniform vec2 u_viewport;":""}
${w?Kt(y)+"flat in float v_envAxial;":""}
${c||x?xl:""}
${R?C:""}
${q?zu:""}
${V?Zu.replace("/*SCREEN_PRINT*/",g??"vec3 screenPrintShade(int start,vec2 uv,vec3 rgb,float footprint,float light){return rgb;}"):""}
${vl(p)}
${d||n?`${Ao}flat in int v_policySlot;`:""}
${d?`uniform vec3 u_pal[${Nt}], u_out[${Nt}]; uniform int u_n;
uniform float u_toneOn, u_grade;
uniform vec2 u_lookGrid, u_lookViewportScale;
${Vn}`:""}
${n?So+jn(u).replaceAll("LOOK_IO","in")+hl(u):""}
${o?kr(s,i,r)+(c?"":"flat in float v_waterAxial;"):""}
void main(){
  ${S?"gl_FragDepth = gl_FragCoord.z;":""}
  ${b?"if(!spriteGeometry(v_spriteLod,gl_FragCoord.xy*u_spriteLodGrid))discard;":""}
${e?e.fsMain:""}  float power = -0.5 * (v_conic.x * v_d.x * v_d.x + v_conic.z * v_d.y * v_d.y) - v_conic.y * v_d.x * v_d.y;
  ${R?`
  bool shaped=v_footprintStyle.x>0.0;
  bool footprintPlane=v_footprintZ.y>0.5;
  float footprintAxial=0.0,footprintDepth=gl_FragCoord.z;
  gl_FragDepth=gl_FragCoord.z;
  if(footprintPlane){
    vec2 pixel=(gl_FragCoord.xy-u_viewport*0.5)/u_focal;
    vec3 rayOrigin=u_ortho>0.5?vec3(pixel,0.0):vec3(0.0);
    vec3 rayDirection=u_ortho>0.5?vec3(0.0,0.0,-1.0):vec3(pixel,-1.0);
    float denominator=dot(v_footprintPlane.xyz,rayDirection);
    if(abs(denominator)<1e-10)discard;
    float distance=(v_footprintPlane.w-dot(v_footprintPlane.xyz,rayOrigin))/denominator;
    footprintAxial=distance;
    if(distance<=0.0)discard;
    vec4 projected=u_proj*vec4(0.0,0.0,-distance,1.0);
    footprintDepth=projected.z/projected.w*0.5+0.5;
    if(footprintDepth<0.0||footprintDepth>1.0)discard;
    if(u_geometryDepth)gl_FragDepth=footprintDepth;
  }
  float profile;
  if(shaped){
    vec2 point=vec2(dot(v_footprintMap.xy,v_d),dot(v_footprintMap.zw,v_d));
    if(footprintPlane&&u_ortho<0.5)point*=footprintAxial/-v_footprintZ.x;
    float distance=footprintDistance(u_footprintAtlas,v_footprintStyle.x,u_footprintColumns,point);
    profile=footprintCoverage(distance,v_footprintStyle.y);
  }else {if(power>0.0||power < -4.5)discard;profile=exp(power);}
  float g=v_color.a*profile;
  `:`if (power > 0.0 || power < -4.5) discard;
  float g = v_color.a * exp(power);`}
  bool continuous = v_coverage == ${K};
  float surfaceAlpha = continuous ? smoothstep(${H}, ${pe.toFixed(2)}, g) : 0.0;
  ${T?"bool hasOptical = v_optical.w > 0.5; if (hasOptical && v_optical.x == 0.0) discard;":""}
  ${x?`
  float sectionAxial = ${R?"footprintPlane?footprintAxial:":""}v_sectionSample.x + clamp(dot(v_sectionSample.yz, v_d), -v_sectionSample.w, v_sectionSample.w);
  if (sectionAxial < u_near) discard;
  vec3 inView = axialPosition(gl_FragCoord.xy, sectionAxial, u_viewport);
  vec3 inWorld = transpose(mat3(u_view)) * (inView - u_view[3].xyz);
  float margin = sectionMargin(inWorld, sectionAxial);
  if (margin < 0.0) discard;
  float cutInk = sectionInk(margin);
  vec4 sectionProjected = u_proj * vec4(inView,1.0);
  float sectionZ = sectionProjected.z / sectionProjected.w * 0.5 + 0.5;
  gl_FragDepth = u_geometryDepth ? clamp(sectionZ,0.0,1.0) : gl_FragCoord.z;
  float sectionDepth = clamp((sectionAxial - u_fogp.z) / (u_fogp.w - u_fogp.z), 0.0, 1.0);
  `:""}
  ${c?`
  float axial = v_portalDepth.x + dot(v_portalDepth.yz, v_d);
  bool clipped = any(notEqual(u_splatPlane.xyz, vec3(0.0))) || any(notEqual(u_portalCoverPlane.xyz, vec3(0.0)));
  if (clipped) {
    vec4 at = vec4(axialPosition(gl_FragCoord.xy, axial, u_viewport), 1.0);
    if (axial <= 0.0 || dot(u_splatPlane, at) < 0.0 || dot(u_portalCoverPlane, at) < 0.0) discard;
  }
  `:""}
  ${k?"":de}
  ${I?`
  ${x||R?"":"gl_FragDepth=gl_FragCoord.z;"}
  float proxyDepth = v_depth, proxyGain = 1.0;
  bool proxyOwnsDepth = false;
  if (v_gaussianProxy > 0) {
    int layer=(v_gaussianProxy&15)-1, role=v_gaussianProxy>>4;
    vec4 surface=texelFetch(u_gaussianProxyLayers,ivec3(ivec2(gl_FragCoord.xy*u_proxyGrid),layer),0);
    bool hit=surface.r>0.0;
    if (role==2 && !hit) discard;
    if (hit && role==3) {
      proxyOwnsDepth=true;
      proxyDepth=dot(round(surface.ba*255.0),vec2(256,1))/65535.0;
      vec4 p=u_proxyProjection*vec4(0,0,-mix(u_proxyDepthRange.x,u_proxyDepthRange.y,proxyDepth),1);
      gl_FragDepth=p.z/p.w*0.5+0.5;
    }
    if (hit && role==4) proxyGain=proxyLighting(proxyNormal(surface.rg),u_proxyLights[layer]);
  }
  `:""}
  ${k?`
  float meshSampleDepth=${I?"proxyOwnsDepth?gl_FragDepth:":""}
    ${x?"sectionZ":R?"(footprintPlane?footprintDepth:v_ownerDepth)":"v_ownerDepth"};
  float meshLimit=texelFetch(u_meshDepthProxy,ivec2(gl_FragCoord.xy),0).r;
  if(meshLimit<1.0&&meshSampleDepth>meshLimit+2e-7)discard;
  `:""}
  ${k?de:""}
  ${m?`
  ${x||R?"":"gl_FragDepth = gl_FragCoord.z;"}
  if (u_idx > 2.5) {
    if (v_gl < 0.5 || g ${T?"* (hasOptical ? v_optical.x : 1.0)":""} < 0.004) discard;
    float depth = ${x?"sectionZ":R?"(footprintPlane?footprintDepth:v_ownerDepth)":"v_ownerDepth"};
    float z = round(clamp(depth,0.0,1.0)*16777215.0);
    gl_FragDepth = clamp(depth,0.000001,1.0);
    o = vec4(mod(z,256.0),mod(floor(z/256.0),256.0),floor(z/65536.0),255.0)/255.0;
    return;
  }`:""}
  ${c?`
  if (u_idx > 1.5) {
    if (v_coverage == ${P} || v_color.a < 0.5 || (continuous ? surfaceAlpha <= 0.5 : g < 0.38)${T?" || hasOptical":""}) discard;
    o = vec4(1.0); od = vec4(0.0); oa = vec4(0.0);
    return;
  }
  `:`
  if (u_idx > 1.5) {
    if (v_coverage == ${P} || v_color.a < 0.5 || (continuous ? surfaceAlpha <= 0.5 : g < 0.38)${T?" || hasOptical":""}) discard;
    float k = v_ix + 1.0, z = round(clamp(${x?"sectionZ":R?"(footprintPlane?footprintDepth:v_ownerDepth)":"v_ownerDepth"}, 0.0, 1.0) * 16777215.0);
    o = vec4(mod(k, 256.0), mod(floor(k / 256.0), 256.0), floor(k / 65536.0), 255.0) / 255.0;
    od = vec4(mod(z, 256.0), mod(floor(z / 256.0), 256.0), floor(z / 65536.0), 255.0) / 255.0;
    oa = vec4(0);
    return;
  }
  `}
  if (u_idx > 0.5) {
    // The owner pass keeps depth for engraved dabs and leaves their color to the paint pass.
    if (u_gaussianNormalCutoff > 0.0) {
      float alpha = continuous ? surfaceAlpha : contributionAlpha(power, v_color.a, false);
      if (alpha < u_gaussianNormalCutoff || v_depth < 0.0) discard;
    } else if (v_color.a < 1.0 ${I?"&& !proxyOwnsDepth":""} || (continuous ? surfaceAlpha <= 0.5 : g < 0.5) || v_depth < 0.0) discard;
    ${x?"if (cutInk > 0.0) { o = vec4(0.0); od = vec4(0.0); oa = vec4(0.0); return; }":""}
    ${q?Mu:""}
    float k = ${V?"v_engravingSlot>0 ? 0.0 : ":""}v_ix + 1.0;
    o = vec4(mod(k, 256.0), mod(floor(k / 256.0), 256.0), floor(k / 65536.0), 255.0) / 255.0;
    od = vec4(0.0); ${n?`if (v_policySlot > 0) {${_l}}`:""}
    float graphDepth = round(clamp(${I?"(proxyOwnsDepth ? proxyDepth : "+(x?"sectionDepth":"v_depth")+")":x?"sectionDepth":"v_depth"}, 0.0, 1.0) * 16777215.0);
    oa = vec4(mod(graphDepth,256.0), mod(floor(graphDepth/256.0),256.0), floor(graphDepth/65536.0),255.0)/255.0; ${m&&!o?"o_back = oa;":""} return; }
  bool solid = u_crisp > 0.5 && v_color.a >= 1.0 && v_coverage != ${P};
  float a = continuous ? surfaceAlpha :
    (solid && u_hard > 0.5 ? (g > 0.5 ? 1.0 : 0.0) : contributionAlpha(power,v_color.a,solid));
  ${_?`
  if (!continuous && solid && u_hard < 0.5 && v_pixelStyle.x > 0.0) {
    float width = 0.36 * (2.0 - v_pixelStyle.x);
    a = 0.99 * (width > 0.0 ? smoothstep(0.5 - width, 0.5 + width, g) : step(0.5, g));
  }`:""}
  ${R?"if(shaped) a=min(.99,g);":""}
  ${f?"a *= v_detailGeometry;":""}
  if (a < 0.004) discard;
  ${W?`if(u_filterMatte){
    o=vec4(vec3(filterSoftness(int(v_ix))*a),a);od=vec4(0);oa=vec4(0);
    return;
  }`:""}
  vec3 rgb = v_color.rgb;
${_?`
  if ((v_fk < 0.0${f?" || v_detailTexture < 1.0":""}) && (int(v_pixelStyle.y) & 2048) != 0) {
    float rank = pixelStyleThreshold(int(v_pixelStyle.y) & 7, ivec2(gl_FragCoord.xy / u_materialGridScale));
    float pk = fract(v_pixelStyle.y) * 2.0 > rank ? v_pixelStyle.w : v_pixelStyle.z;
    vec3 shade = vec3(mod(pk, 256.0), mod(floor(pk / 256.0), 256.0), floor(pk / 65536.0)) / 255.0;
    rgb = mix(shade, u_fog, v_pixelFog);
  }`:""}
    if (v_fk >= 0.0) {   // inked detail: this pixel's own place on the dab's tile
    ivec2 ij = clamp(ivec2(floor(vec2(dot(v_fm.xy, v_d), dot(v_fm.zw, v_d)) * 2.0 + 2.0)), ivec2(0), ivec2(3));
    float f = ij.y == 0 ? v_ft.x : ij.y == 1 ? v_ft.y : ij.y == 2 ? v_ft.z : v_ft.w;
    int ci = int(mod(floor(f / (ij.x == 0 ? 1.0 : ij.x == 1 ? 64.0 : ij.x == 2 ? 4096.0 : 262144.0)), 64.0));
    vec3 tile = mix(u_fpal[ci], u_fog, v_fk);
    rgb = ${f?"mix(rgb, tile, v_detailTexture)":"tile"}; }
${z?"rgb = facingFragment(rgb, u_fog, u_viewport, u_focal, u_ortho > 0.5);":""}
${F?"if (v_relight.w > 0.0) rgb = mix(min(vec3(1.0), rgb * v_relight.xyz), u_fog, v_relight.w - 1.0);":""}
${T?`
  if (hasOptical) {
    rgb = (v_scatterTint.x >= 0.0 ? v_scatterTint : rgb) * v_optical.y + v_reflectTint * v_optical.z;
    rgb = mix(rgb, u_fog, v_opticalFog);
    a *= v_optical.x;
    if (a < 0.004) discard;
  }`:""}
${V?"rgb=engravingShade(rgb,v_d);":""}
${d?`  if (v_policySlot > 0) {
    ivec2 p = ivec2(floor(gl_FragCoord.xy * u_lookViewportScale));
    p.y = int(u_lookGrid.y) - 1 - p.y;
    vec3 next = paletteRow(v_policySlot, rgb, p);
    float mask = ${n?"maskAt(v_policySlot)":"1.0"};
    if (mask < 1.0) {
      vec3 base = rgb;
      ${n?`if (u_constraintDefault > 0 && maskSettings(u_constraintDefault).x == 0.0)
        base = paletteRow(u_constraintDefault, rgb, p);`:""}
      next = mix(base, next, mask);
    }
    rgb = next;
  }`:""}
${x?"rgb = mix(rgb, u_sectionEdge.rgb, cutInk);":""}
${o?`  vec3 mark; rgb = waterPaint(rgb, gl_FragCoord.xy, u_viewport,
    ${x?"sectionAxial":c?"clipped ? axial : v_portalDepth.x":"v_waterAxial"}, mark);`:""}
  ${w?"rgb = envMedia(rgb, gl_FragCoord.xy, u_viewport, "+(x?"sectionAxial":"v_envAxial")+");":""}
  ${I?"rgb*=proxyGain;":""}
  ${ae?`
  if(u_coverageVotePass){
    if(!solid||v_depth<0.0||v_gl>0.0||a<0.5)discard;
    float row=v_ix+1.0;
    float depth=round(clamp(v_depth,0.0,1.0)*65535.0);
    o=vec4(rgb,mod(depth,256.0)/255.0);
    od=vec4(mod(row,256.0),mod(floor(row/256.0),256.0),floor(row/65536.0),floor(depth/256.0))/255.0;
    oa=vec4(0);
    return;
  }
  `:""}

${Z?uu:""}
  if (u_paintPass) {
    // Every fragment attenuates the overlay behind it.
    bool overlay = v_paint != 0 ${T?"|| hasOptical":""};
    o = vec4(overlay ? rgb * a : vec3(0.0), a);
    od = vec4(overlay ? a : 0.0, 0.0, 0.0, a);
    return;
  }
  o = vec4(rgb * a, a);
  ${m?`vec4 pane = texelFetch(u_glassBoundary,ivec2(gl_FragCoord.xy),0);
  // Keep near-coplanar transparent contributions together through crossings.
  float splitDepth = v_depth < 0.0 || v_color.a < 1.0 ? v_glassNearDepth : ${x?"sectionZ":R?"(footprintPlane?footprintDepth:v_ownerDepth)":"v_ownerDepth"};
  bool behind = pane.a > 0.0 && splitDepth > glassDepth(pane)+0.0000001;
  o_back = behind ? o : vec4(0.0);
  o_through = pane.a > 0.0 && !behind ? vec4(0.0,0.0,0.0,a) : vec4(0.0);`:""}
  float a2 = (v_color.a >= 1.0 ${I?"|| proxyOwnsDepth":""}) && v_depth >= 0.0 ? a : 0.0;   // only solid splats write depth
  od = vec4(${I?"(proxyOwnsDepth ? proxyDepth : "+(x?"sectionDepth":"v_depth")+")":x?"sectionDepth":"v_depth"} * a2, v_gl * a * 0.5, v_lit * a2, a2);   // (green: how much glass lies over this pixel, in front of the last solid thing; a solid splat wipes it)
  ${S?`
  if (u_surfacePeel) {
    float axial;
    oa = surfacePeelKey(axial);
    od.r = clamp((axial - u_surfaceRange.x) / (u_surfaceRange.y - u_surfaceRange.x), 0.0, 1.0) * a2;
    return;
  }`:""}
  oa = ${o?"vec4(mark * a, a)":"vec4(v_as * a, v_ast * 0.25 * a, 0.0, a)"};
}`;return{vertex:ye,fragment:Y}}var Vn=`
// OKLab and matching coordinates mirror PixelLook.preparePalette.
vec4 paletteLab(vec3 rgb) {
  vec3 m = abs(rgb);
  vec3 c = sign(rgb) * mix(pow((m+.055)/1.055,vec3(2.4)),m/12.92,lessThanEqual(m,vec3(.04045)));
  vec3 lms = vec3(dot(vec3(.4122214708,.5363325363,.0514459929),c),
                  dot(vec3(.2119034982,.6806995451,.1073969566),c),
                  dot(vec3(.0883024619,.2817188376,.6299787005),c));
  lms = sign(lms)*pow(abs(lms),vec3(1.0/3.0));
  vec3 lab = vec3(dot(vec3(.2104542553,.7936177850,-.0040720468),lms),
                  dot(vec3(1.9779984951,-2.4285922050,.4505937099),lms),
                  dot(vec3(.0259040371,.7827717662,-.8086757660),lms));
  return vec4(lab,length(lab.yz));
}
float paletteLabDistance(vec4 a, vec4 b, int mode, float hue) {
  vec4 q = a-b;
  float distance = (mode == 2 ? 25.0 : 1.0)*q.x*q.x+dot(q.yz,q.yz);
  if (mode == 3) distance += 25.0*q.w*q.w;
  if (hue > 0.0) {
    vec2 d = a.yz/max(.04,a.w)-b.yz/max(.04,b.w);
    distance += hue*dot(d,d);
  }
  return distance;
}
bool paletteAccess(int slot, int row, int base) {
  int bits = int(texelFetch(u_constraintRows, ivec2(base + slot / 24, row), 0).a);
  return (bits & (1 << (slot % 24))) != 0;
}
vec3 paletteRow(int slot, vec3 inputColor, ivec2 p) {
  int row = slot - 1;
  vec4 settings = texelFetch(u_constraintRows, ivec2(0, row), 0);
  int count = int(settings.x), total = int(settings.y);
  vec3 bytes = floor(clamp(inputColor, 0.0, 1.0) * 255.0 + 0.5);
  const vec3 weight = vec3(0.30, 0.55, 0.15);
  vec3 gradedBytes = bytes, gradedReserve = vec3(0.0);
  bool hasGradedReserve = false;
  float mapping = texelFetch(u_constraintRows, ivec2(3, row), 0).a;
  if (mapping > 0.5 || (u_toneOn < 0.5 && u_grade > 0.5 && texelFetch(u_constraintRows, ivec2(2, row), 0).a > 0.5)) {
    int index = 0; float nearestDistance = 1e9;
    for (int i = 0; i < u_pal.length(); i++) {
      if (i >= u_n) break;
      vec3 d = inputColor - u_pal[i];
      float distance = dot(weight, d * d);
      if (distance < nearestDistance) { index = i; nearestDistance = distance; }
    }
    inputColor = mapping > 0.5 ? texelFetch(u_constraintRows, ivec2(u_constraintMap + index, row), 0).rgb : u_out[index];
    if (mapping > 1.5) { return inputColor; }
    gradedBytes = floor(clamp(inputColor, 0.0, 1.0) * 255.0 + 0.5);
  }
  int mode = int(texelFetch(u_constraintRows, ivec2(4, row), 0).a);
  vec4 inputLab = mode == 0 ? vec4(0.0) : paletteLab(inputColor);
  float hue = mode == 4 ? .49*smoothstep(.02,.06,inputLab.w) : 0.0;
  float firstDistance = 1e9;
  int bestSlot = 0;
  vec3 best = vec3(0.0), second = vec3(0.0);
  vec4 firstLab = vec4(0.0), secondLab = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    if (i >= total) break;
    vec3 swatch = texelFetch(u_constraintRows, ivec2(i + 1, row), 0).rgb;
    if (i >= count) {
      vec3 code = floor(swatch * 255.0 + 0.5);
      if (all(equal(bytes, code))) { return swatch; }
      if (all(equal(gradedBytes, code))) { gradedReserve = swatch; hasGradedReserve = true; }
      if (!paletteAccess(i, row, 8)) continue;
    }
    vec3 d = inputColor - swatch;
    vec4 swatchLab = mode == 0 ? vec4(0.0) : texelFetch(u_constraintRows,ivec2(u_constraintLab+i,row),0);
    float distance = mode == 0 ? dot(weight,d*d) : paletteLabDistance(inputLab,swatchLab,mode,hue);
    if (distance < firstDistance) {
      best = swatch; firstDistance = distance; firstLab = swatchLab; bestSlot = i;
    }
  }
  if (hasGradedReserve) { return gradedReserve; }
  vec3 color = best;
  float amount = texelFetch(u_constraintRows, ivec2(1, row), 0).a;
  float gain = texelFetch(u_constraintRows, ivec2(7, row), 0).a;
  if (total < 2 || amount == 0.0 || gain <= 0.0 ||
      (bestSlot >= count && !paletteAccess(bestSlot, row, 10))) return color;
  ivec2 size = ivec2(settings.zw);
  float scale = texelFetch(u_constraintRows, ivec2(6, row), 0).a;
  ivec2 grid = ivec2(floor(vec2(p) / scale));
  int cell = (grid.y % size.y) * size.x + grid.x % size.x;
  float rank = texelFetch(u_constraintRows, ivec2(49 + cell / 4, row), 0)[cell & 3] / gain;
  if (rank >= .5) return color;
  int pairCount = int(texelFetch(u_constraintRows,ivec2(5,row),0).a)-1;
  int partner = -1;
  float secondDistance = 1e9;
  float lightness = mode == 0 ? -1.0 : clamp(inputLab.x,0.0,1.0);
  int entries = pairCount >= 0 ? pairCount : total;
  for (int i = 0; i < 256; i++) {
    if (i >= entries) break;
    int candidate = i;
    if (pairCount >= 0) {
      vec4 pair = texelFetch(u_constraintRows, ivec2(u_constraintPairs + i, row), 0);
      ivec2 slots = ivec2(pair.xy);
      candidate = slots.x == bestSlot ? slots.y : slots.y == bestSlot ? slots.x : -1;
      if (candidate < 0) continue;
      if (pair.z >= 0.0) {
        if (lightness < 0.0) lightness = clamp(paletteLab(inputColor).x, 0.0, 1.0);
        if (lightness < pair.z || lightness > pair.w) continue;
      }
    } else if (candidate == bestSlot || (candidate >= count && !paletteAccess(candidate, row, 10))) continue;
    vec3 rgb = texelFetch(u_constraintRows, ivec2(candidate + 1, row), 0).rgb;
    vec4 lab = mode == 0 ? vec4(0.0) : texelFetch(u_constraintRows, ivec2(u_constraintLab + candidate, row), 0);
    vec3 d = inputColor - rgb;
    float distance = mode == 0 ? dot(weight, d*d) : paletteLabDistance(inputLab, lab, mode, hue);
    if (distance < secondDistance || distance == secondDistance && candidate < partner) {
      partner = candidate;
      second = rgb;
      secondLab = lab;
      secondDistance = distance;
    }
  }
  if (partner < 0) return color;
  float threshold = .5+(rank-.5)*amount;
  if (mode != 0) {
    float reach = paletteLabDistance(firstLab,secondLab,mode,hue);
    return reach > 0.0 && .5*(firstDistance+reach-secondDistance) >= threshold*reach ? second : color;
  }
  vec3 delta = second-best;
  if (dot(weight*delta,inputColor-best) >= threshold*dot(weight,delta*delta)) color = second;
  return color;
}
`;function Op(e,t){let o=t?Vn.replace("float gain = texelFetch(u_constraintRows, ivec2(7, row), 0).a;","float gain = 1.0;").replace("ivec2 grid = ivec2(floor(vec2(p) / scale));",`ivec2 pixel=ivec2(p.x,textureSize(u_markWorld,0).y-1-p.y);
  vec4 rule=texelFetch(u_constraintRows,ivec2(u_constraintAnchor,row),0);
  vec3 placement=texelFetch(u_constraintRows,ivec2(u_constraintAnchor+1,row),0).xyz;
  int space=int(placement.x);
  gain=markGain(pixel,rule,space,scale,placement.yz);
  if(gain<=0.)return color;
  ivec2 grid=positiveGrid(markCoordinates(pixel,p,rule,space,scale),size);`):Vn;return`${Ao}${t?"uniform int u_constraintAnchor;":""}${o}
bool g_constrained = false;
${e?`${So}
uniform highp sampler2D u_maskOwner;
vec3 defaultMaskColor(vec3 rgb, ivec2 p) {
  float th = (BAYER[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0 - 0.5;
  rgb = clamp(rgb + th * u_dither, 0.0, 1.0);
  int best = 0; float bd = 1e9;
  for (int i = 0; i < u_pal.length(); i++) {
    if (i >= u_n) break;
    vec3 d = rgb - u_pal[i];
    float dd = dot(d*d, vec3(0.30, 0.55, 0.15));
    if (dd < bd) { bd = dd; best = i; }
  }
  return u_grade > 0.5 ? u_out[best] : u_pal[best];
}`:""}
bool constrainPalette(ivec2 p, vec3 inputColor, out vec3 color) {
  int index = dabAt(p);
  if (index < 0) return false;
  int slot = contributionSlot(index);
  if (slot == 0) return false;
  ivec2 pos = ivec2(p.x, textureSize(u_idxTex, 0).y - 1 - p.y);
  color = paletteRow(slot,inputColor,pos);
  ${e?`if (maskSettings(slot).x != 0.0) {
    vec2 encoded = floor(texelFetch(u_maskOwner,p,0).rg * 255.0 + 0.5);
    float amount = dot(encoded, vec2(1.0,256.0)) / 65535.0;
    if (amount < 1.0) {
      vec3 base = u_constraintDefault > 0 && maskSettings(u_constraintDefault).x == 0.0 ?
        paletteRow(u_constraintDefault,inputColor,pos) : defaultMaskColor(inputColor,p);
      color = mix(base,color,amount);
    }
  }`:""}
  return true;
}`}function gl(e,{water:t=!1,airPockets:o=!1,layered:s=!1,atlas:i=!1,paletteConstraints:r=!1,masked:c=!1,contributions:l=!1,layeredGlass:d=!1,materialStyles:n=!1,environment:u=!1,emitterFog:m=!1,relighting:p=!1,packedTone:_=!1,cutaway:w,facingColors:y=!1,protectGaps:F=!1,marks:T=!1,patternedResolve:f=!0,coloredResolve:x=!0,paintResolve:E=!0}={}){let R=`
uniform highp sampler2D u_waterMask;
ivec2 waterPixel(ivec2 p) {
  vec3 mark = texelFetch(u_waterMask, p, 0).rgb;
  if (mark.x < 0.98) return p;
  int body = int(round(mark.y * 255.0)), code = int(round(mark.z * 255.0));
  ivec2 shift = ivec2(code % 9 - 4, code / 9 - 4);
  ivec2 dest = clamp(p + shift, ivec2(0), textureSize(u_waterMask, 0) - 1);
  vec3 other = texelFetch(u_waterMask, dest, 0).rgb;
  return other.x >= 0.98 && int(round(other.y * 255.0)) == body ? dest : p;
}
`,C=`
uniform highp sampler2D u_detailFlags;
int detailAt(highp sampler2D owners, ivec2 p) {
  ivec3 owner = ivec3(round(texelFetch(owners, p, 0).rgb * 255.0));
  int i = owner.r + owner.g * 256 + owner.b * 65536 - 1;
  if (i < 0) return 0;
  return 8 | int(texelFetch(u_detailFlags, ivec2((i >> 2) & 511, i >> 11), 0)[i & 3]);
}
bool protectedGap(highp sampler2D owners, sampler2D depths, ivec2 p) {
  ivec2 size = textureSize(depths, 0);
  float depth = texelFetch(depths, p, 0).r;
  for (int axis = 0; axis < 2; axis++) {
    ivec2 step = axis == 0 ? ivec2(1, 0) : ivec2(0, 1);
    ivec2 a = p - step, b = p + step;
    if (any(lessThan(a, ivec2(0))) || any(greaterThanEqual(b, size))) continue;
    float front = max(texelFetch(depths, a, 0).r, texelFetch(depths, b, 0).r);
    if (depth - front <= 0.004) continue;
    int group = detailAt(owners, a) >> 4;
    if (group != 0 && group == (detailAt(owners, b) >> 4)) return true;
  }
  return false;
}
`,V=`#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`,q=`#version 300 es
precision highp float;
${r||n||p||F?"precision highp int;":""}
uniform sampler2D u_scene, u_depth, u_crispScene, u_crispDepth;
${u?Kt(m):""}
uniform bool u_paintOn;
${p?qn+"uniform vec3 u_relightFog; uniform vec2 u_relightFogRange;":""}
uniform vec3 u_line;
uniform float u_edge;
// the tone look (a diorama's look.tone, or the Tone option: PixelLook's stipple): brightness below the cutoff is black, the rest
// mapped onto the stops (u_toneStops: colour, and its place in .a), each pixel between two stops taking one or the other by its rank
// in a fixed pattern (Bayer or blue noise) on the screen's art grid
uniform float u_toneOn, u_toneCut, u_toneAmt; uniform int u_toneN; uniform highp sampler2D u_toneStops;
${_?"uniform ivec2 u_toneThSize;":"uniform highp sampler2D u_toneTh;"}
uniform vec3 u_pal[${Nt}], u_out[${Nt}], u_outl[${Nt}];   // (u_outl: what each colour is shown as where a carried light falls on it)
uniform int u_n;
uniform float u_grade; uniform float u_bars; uniform int u_remapLine;
uniform float u_dither, u_luma, u_bypass, u_colored, u_refract, u_ao, u_aor;
uniform float u_lines, u_lineGap, u_lineK, u_lineLit;
out vec4 o;
${t?kr(o,s,i)+R:""}
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
const ivec2 AOT[8] = ivec2[8](ivec2(2, 0), ivec2(-2, 0), ivec2(0, 2), ivec2(0, -2), ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1));
// light in the air behind a round stained window (a diorama's .glass): the window's centre and radius, the way its light travels, six glass
// colours, and the eye. Each pixel's line of sight is walked where it crosses the beam; every step adds the colour of the pane it lies behind,
// thinned or thickened by a haze that drifts, and the sum is added to the finished picture: this is light, so it is not held to the palette.
uniform mat4 u_gview; uniform vec3 u_geye, u_gd; uniform vec4 u_gw, u_gcam; uniform float u_gk, u_gtime, u_gortho; uniform vec3 u_gc[6];
// colour per pixel (a diorama's look.pixel): the solid dab in front at each pixel (u_idxTex), what it is coloured from (u_pixTex: its
// ramp, how lit, its pattern, the way its surface truly faces), its middle (u_data); the camera, to meet each pixel's line of sight
// with the dab's plane; the patterns and ramps. The pixel is coloured at that exact place, its light the mean of the pixels round
// it on the same ramp and surface, and a stone, tile or board's edge is drawn where the cell changes from this pixel to the next
uniform highp sampler2D u_idxTex, u_pixTex, u_dat; uniform float u_pixOn, u_tanF, u_asp, u_fpG, u_ol, u_olEps, u_olGap, u_ptime, u_portho, u_shape; uniform int u_olK; uniform mat4 u_pview; uniform vec3 u_peye;
uniform vec4 u_patK4[8], u_patP[128], u_rmp4[128], u_rmpN4[16]; uniform float u_detail;
int jm2(int v) { return v - 2 * int(trunc(float(v) * 0.5)); }   // (v % 2 as script does it, negative for a negative odd v)
int dabAt(ivec2 q) { ivec2 s = textureSize(u_idxTex, 0); if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) return -1;
  vec4 e = texelFetch(u_idxTex, q, 0) * 255.0; return int(e.r + 0.5) + int(e.g + 0.5) * 256 + int(e.b + 0.5) * 65536 - 1; }
vec4 pixA(int i) { return texelFetch(u_pixTex, ivec2((i & 1023) * 2, i >> 10), 0); }
vec4 pixB(int i) { return texelFetch(u_pixTex, ivec2((i & 1023) * 2 + 1, i >> 10), 0); }
uint hsh(int i, int j, int k, int s) { uint h = uint(i) * 374761393u + uint(j) * 668265263u + uint(k) * 1440662683u + uint(s) * 1274126177u;
  h = (h ^ (h >> 13u)) * 1274126177u; h ^= h >> 16u; h *= 2246822519u; h ^= h >> 13u; return h; }
float hsf(int i, int j, int k, int s) { return float(hsh(i, j, k, s)) / 4294967296.0; }
int rlen(int r) { return int(u_rmpN4[r >> 2][r & 3] + 0.5) & 15; }
bool lineOff(int r) { return (int(u_rmpN4[r >> 2][r & 3] + 0.5) & 16) != 0; }
// two ramps of one material (its shade ramp and its lit one share colours where they meet): not an edge between things
bool sameStuff(int a, int b) { return a == b || (int(u_rmpN4[a >> 2][a & 3] + 0.5) >> 5) == (int(u_rmpN4[b >> 2][b & 3] + 0.5) >> 5); }
int rampAt(int r, int b) { int x = r * 8 + clamp(b, 0, rlen(r) - 1); return int(u_rmp4[x >> 2][x & 3] + 0.5); }
int bandOf(int r, float t) { return clamp(int(floor(t * float(rlen(r)))), 0, rlen(r) - 1); }
float lvl(float px0, float fp) { return fp > 0.0 ? px0 * exp2(floor(log2(fp / px0) + 0.5)) : px0; }
// where this pixel's line of sight meets the plane of dab i, and how big a screen pixel is there
vec4 hitOf(ivec2 q, int i, vec3 n) { ivec2 sz = textureSize(u_idxTex, 0);
  vec3 v = vec3(((float(q.x) + 0.5) / float(sz.x) * 2.0 - 1.0) * u_tanF * u_asp, ((float(q.y) + 0.5) / float(sz.y) * 2.0 - 1.0) * u_tanF, -1.0);
  // (orthographic: each line of sight starts at its own point on the picture's plane and all run straight ahead)
  vec3 o0 = u_portho > 0.5 ? u_peye + transpose(mat3(u_pview)) * vec3(v.xy, 0.0) : u_peye;
  vec3 d = transpose(mat3(u_pview)) * (u_portho > 0.5 ? vec3(0.0, 0.0, -1.0) : v); vec3 c = texelFetch(u_dat, ivec2((i & 511) << 2, i >> 9), 0).xyz;
  float den = dot(n, d), s = abs(den) > 1e-6 ? dot(n, c - o0) / den : 0.0;
  // (a pixel's size on the surface, for the pattern's level: the same over a whole face, from the camera's distance and the face's slant)
  float ce = abs(dot(n, vec3(u_pview[0][2], u_pview[1][2], u_pview[2][2])));
  return s > 0.0 ? vec4(o0 + d * s, u_fpG / max(0.3, ce)) : vec4(c, 0.0); }
// a pattern's cell where the pixel lands (the same over one stone, tile or board), and the colours of its body and edges
struct Cell { ivec3 key, sel; int body, below, above, left; };
ivec2 g_q;   // (the pixel being coloured, for patterns drawn as upright pixel pictures)
float g_fp;   // (and the size of a screen pixel on its surface)
/* points pinned to the world, nested over detail levels. Level L's cells (a size times 2^L) each show one point: the one its chosen
   child shows, and so down to the finest level (LMIN). So a point shown at one level is shown at every finer one, in the same place:
   zooming out takes points away one by one (between L and L + 1 the cells not chosen by their parent go, each at its own moment)
   and zooming in brings them back; none ever moves */
const int LMIN = -2;
bool shown2(ivec2 c, int L, float f, int sd) { ivec2 pa = ivec2(floor(vec2(c) * 0.5)); int ch = int(hsf(pa.x, pa.y, 21 + L, sd) * 4.0);
  return c - pa * 2 == ivec2(ch & 1, ch >> 1) || hsf(c.x, c.y, 41 + L, sd) >= f; }
ivec2 atom2(ivec2 c, int L, int sd) { for (int l = 0; l < 8; l++) { if (L - l <= LMIN) break; int ch = int(hsf(c.x, c.y, 20 + L - l, sd) * 4.0); c = c * 2 + ivec2(ch & 1, ch >> 1); } return c; }
bool shown3(ivec3 c, int L, float f, int sd) { ivec3 pa = ivec3(floor(vec3(c) * 0.5)); int ch = int(hsf(pa.x + 7 * pa.z, pa.y, 21 + L, sd) * 8.0);
  return c - pa * 2 == ivec3(ch & 1, (ch >> 1) & 1, ch >> 2) || hsf(c.x + 7 * c.z, c.y, 41 + L, sd) >= f; }
ivec3 atom3(ivec3 c, int L, int sd) { for (int l = 0; l < 8; l++) { if (L - l <= LMIN) break; int ch = int(hsf(c.x + 7 * c.z, c.y, 20 + L - l, sd) * 8.0); c = c * 2 + ivec3(ch & 1, (ch >> 1) & 1, ch >> 2); } return c; }
// (the level for a surface's pixel size: L and how far toward L + 1)
int nestL(float p, out float f) { float lam = clamp(log2(max(g_fp, 1e-6) / p), float(LMIN), 4.0); int L = int(floor(lam)); f = lam - float(L); return L; }
const int TUFTS[6] = int[6](17732, 4782, 324, 11118, 2700, 8524); const int LEAFM[4] = int[4](2274, 4812, 10692, 5312); const int CLUMPS[4] = int[4](42975166, 17211164, 38797084, 9150366); const int NEEDLES[4] = int[4](21956, 3268, 24964, 10368); const int CRACKS[4] = int[4](1100, 4289, 368, 192); const int RIPPLES[4] = int[4](14, 108, 7, 22);
vec3 unfoldN(vec2 q, vec3 dflt) { if (q.x > 8.0) return dflt; float y = 1.0 - abs(q.x) - abs(q.y); vec2 xz = q;
  if (y < 0.0) xz = (1.0 - abs(q.yx)) * vec2(q.x >= 0.0 ? 1.0 : -1.0, q.y >= 0.0 ? 1.0 : -1.0); return normalize(vec3(xz.x, y, xz.y)); }
Cell cellAtL(int k, int r, vec3 P, vec3 n, vec3 fn, float t, float p) {
  Cell C; C.key = ivec3(-99999); C.sel = ivec3(0); int b = bandOf(r, t); C.body = rampAt(r, b); C.below = C.body; C.above = C.body; C.left = C.body;
  int kind = int(u_patK4[k >> 2][k & 3] + 0.5); vec4 a = u_patP[k * 4], e = u_patP[k * 4 + 1]; int sd = int(e.x + 0.5);
  if (kind == 1) {   // stones in courses
    float sl = a.x * p, sh = a.y * p; vec3 uvf = abs(n.y) > 0.7 ? vec3(P.x, P.z, 0.0) : abs(n.x) > abs(n.z) ? vec3(P.z * sign(n.x == 0.0 ? 1.0 : n.x), P.y, 1.0) : vec3(-P.x * sign(n.z == 0.0 ? 1.0 : n.z), P.y, 2.0);
    int face = int(uvf.z), row = int(floor(uvf.y / sh)); float off = float(jm2(row)) * 0.5 * sl + hsf(row, face, 0, sd) * sl * 0.3;
    int slot = int(floor((uvf.x + off) / sl)); float su = uvf.x + off - float(slot) * sl;
    bool halfS = hsf(slot, row, face, sd + 9) > 0.86, keepS = hsf(slot, row, face, sd + 7) > 0.28; int col;
    if (halfS && su > sl * 0.5) col = slot * 2 + 1; else if (keepS) col = slot * 2;
    else { int s2 = slot - 1; col = s2 * 2; for (int g = 0; g < 4; g++) { if (hsf(s2, row, face, sd + 9) > 0.86) { col = s2 * 2 + 1; break; } if (hsf(s2, row, face, sd + 7) > 0.28 || g == 3) { col = s2 * 2; break; } s2--; } }
    float hv = hsf(col, row, face, sd + 3); int dd = hv < a.w * 0.6 ? -1 : hv > 1.0 - a.w * 0.4 ? 1 : 0; int n0 = rlen(r);
    C.body = rampAt(r, b + dd); C.below = rampAt(r, b - int(a.z + 0.5)); C.left = C.below; C.above = rampAt(r, b + dd + (b < n0 - 1 ? 1 : 0));
    C.key = ivec3(face, row, col);
  } else if (kind == 2) {   // boards
    float w = a.x * p; int ax = int(a.y + 0.5); float al = ax == 0 ? P.x : ax == 1 ? P.z : P.y;
    float cc = ax == 2 ? (abs(n.x) > abs(n.z) ? P.z : P.x) : abs(n.y) > 0.7 ? (ax == 0 ? P.z : P.x) : P.y;
    int k0 = int(floor(cc / w)); bool wide = hsf(k0, 9, 0, sd) < 0.3; int kk = wide && jm2(k0) != 0 ? k0 - 1 : k0;
    float len = (6.0 + 10.0 * hsf(kk, 0, 0, sd)) * p * 4.0, ee = al + hsf(kk, 1, 0, sd) * len; int seg = int(floor(ee / len));
    C.body = rampAt(r, b + (hsf(kk, seg, 4, sd) < 0.2 ? -1 : 0)); C.below = rampAt(r, b - 2); C.left = C.below; C.above = C.body;
    C.key = ivec3(kk, seg, 0);
  } else if (kind == 3) {   // tiles: the lower edge a lit lip, the upper edge in the row above's shadow, the sides seams
    float tw = a.x * p, th = a.y * p, u = abs(n.x) > abs(n.z) ? P.z : P.x; int row = int(floor(P.y / th));
    float off = float(jm2(row)) * 0.5 * tw; int col = int(floor((u + off) / tw));
    C.body = rampAt(r, b + (hsf(col, row, 0, sd) < 0.08 ? -1 : 0)); C.below = rampAt(r, b + 1); C.above = rampAt(r, b - 2);
    C.left = P.y - float(row) * th < th * 0.5 ? rampAt(r, b - 1) : C.body;   // (seams only on a tile's lower half: shingles, not a grid)
    C.key = ivec3(row, col, 1);
  } else if (kind == 6) {   // thatch: courses along the eaves, bundles shading them, ragged feet; a course is one cell
    float ch = a.x * p, bw = a.y * p, u = abs(n.x) > abs(n.z) ? P.z : P.x; int row = int(floor(P.y / ch)); float f = P.y - float(row) * ch;
    int cU = int(floor((u + hsf(row + 1, 0, 2, sd) * bw) / bw)); float sagU = floor(hsf(cU, row + 1, 1, sd) * (a.z + 0.999)) * p; int col;
    if (f >= ch - sagU) { row++; col = cU; } else col = int(floor((u + hsf(row, 0, 2, sd) * bw) / bw));
    float hv = hsf(col, row, 3, sd); int dd = hv < 0.28 ? -1 : hv > 0.82 ? 1 : 0;
    C.body = rampAt(r, b + dd); C.below = rampAt(r, b + 1); C.above = rampAt(r, b - 2); C.left = rampAt(r, b - 1);
    C.key = ivec3(row, 0, 6);
  } else if (kind == 5) {   // leaves: clusters round Worley points, each lit as a dome and as the crown's shape: scalloped band edges
    float cl = a.x * p; vec3 g = P / cl; ivec3 ig = ivec3(floor(g)); float best = 1e9; vec3 fq = vec3(0.0);
    for (int kz = -1; kz <= 1; kz++) for (int ky = -1; ky <= 1; ky++) for (int kx = -1; kx <= 1; kx++) { ivec3 c3 = ig + ivec3(kx, ky, kz);
      vec3 q = vec3(c3) + 0.15 + 0.7 * vec3(hsf(c3.x, c3.y, c3.z, sd), hsf(c3.x, c3.y, c3.z, sd + 1), hsf(c3.x, c3.y, c3.z, sd + 2)); vec3 dq = q - g; float d2 = dot(dq, dq);
      if (d2 < best) { best = d2; fq = q; } }
    vec3 L = e.yzw, dd = normalize(P - fq * cl), nc = normalize(fn * (1.0 - a.y) + dd * a.y);
    float t2 = t + a.z * (max(0.0, dot(nc, L)) - max(0.0, dot(fn, L))); int b2 = bandOf(r, t2), body = rampAt(r, b2);
    // leaf marks: little upright pixel pictures of leaves at points over the crown, darker in the light and lighter in the shade
    if (a.w > 0.0) { float fr; int L = nestL(p, fr); float mc = u_patP[k * 4 + 2].x * p * exp2(float(L)), mA = u_patP[k * 4 + 2].x * p * exp2(float(LMIN)); ivec3 mg = ivec3(floor(P / mc)); int best = -9, col = -1; ivec2 sz = textureSize(u_idxTex, 0); mat3 V = mat3(u_pview);
      for (int kz = -1; kz <= 1; kz++) for (int ky = -1; ky <= 1; ky++) for (int kx = -1; kx <= 1; kx++) { ivec3 cL = mg + ivec3(kx, ky, kz); if (!shown3(cL, L, fr, sd)) continue; ivec3 c3 = atom3(cL, L, sd);
        if (hsf(c3.x, c3.y, c3.z, sd + 5) > a.w) continue;
        vec3 Q = (vec3(c3) + 0.15 + 0.7 * vec3(hsf(c3.x, c3.y, c3.z, sd), hsf(c3.x, c3.y, c3.z, sd + 1), hsf(c3.x, c3.y, c3.z, sd + 2))) * mA;
        if (dot(Q - P, Q - P) > mc * mc * 1.5) continue;
        vec3 vs = V * (Q - u_peye); float iw = u_portho > 0.5 ? 1.0 : 1.0 / max(-vs.z, 1e-6);
        vec2 sc = vec2((vs.x * iw / (u_tanF * u_asp) + 1.0) * 0.5 * float(sz.x) - 0.5, (vs.y * iw / u_tanF + 1.0) * 0.5 * float(sz.y) - 0.5);
        int ox = int(floor(float(g_q.x) - sc.x + 0.5)), oy = int(floor(float(g_q.y) - sc.y + 0.5));
        if (abs(ox) > 2 || oy < 0 || oy > 2 || oy <= best) continue;
        int m = LEAFM[int(hsf(c3.x, c3.y, c3.z, sd + 6) * 4.0) % 4]; if (((m >> (oy * 5 + ox + 2)) & 1) == 0) continue;
        best = oy; col = rampAt(r, b2 + (float(b2) >= float(rlen(r)) * 0.5 ? -1 : 1)); }
      if (col >= 0) body = col; }
    C.body = body; C.below = body; C.above = body; C.left = body; C.key = ivec3(floor(fq));
  } else if (kind == 7) {   // turf: an even ground (darker in big patches) scattered with upright tufts, each a little pixel picture anchored to the ground
    float ps = a.z, pn = sin(P.x / ps + 1.3 * sin(P.z / (ps * 1.7))) * sin(P.z / ps + 0.9 * sin(P.x / (ps * 1.3)));
    float fr; int L = nestL(p, fr); float cl = a.x * p * exp2(float(L)), cA = a.x * p * exp2(float(LMIN));
    int bb = max(0, b - (pn > 0.55 ? 1 : 0) + int(floor(e.z + 0.5))), body = rampAt(r, bb); int ix = int(floor(P.x / cl)), iz = int(floor(P.z / cl));
    if (n.y >= 0.5) {
      int d = bb <= rlen(r) - 2 ? 1 : -1, best = -9, col = -1, nf = int(a.w + 0.5); bool shade = false; vec4 F0 = u_patP[k * 4 + 2], F1 = u_patP[k * 4 + 3];
      ivec2 sz = textureSize(u_idxTex, 0); mat3 V = mat3(u_pview);
      for (int kz = -1; kz <= 1; kz++) for (int kx = -1; kx <= 1; kx++) { ivec2 c2 = ivec2(ix + kx, iz + kz); if (!shown2(c2, L, fr, sd)) continue;
        ivec2 at2 = atom2(c2, L, sd); int ax = at2.x, cz = at2.y;
        if (hsf(ax, cz, 4, sd) > a.y) continue;
        vec2 qw = vec2((float(ax) + 0.15 + 0.7 * hsf(ax, cz, 0, sd)) * cA, (float(cz) + 0.15 + 0.7 * hsf(ax, cz, 1, sd)) * cA);
        vec3 vs = V * (vec3(qw.x, P.y, qw.y) - u_peye); float iw = u_portho > 0.5 ? 1.0 : 1.0 / max(-vs.z, 1e-6);
        vec2 sc = vec2((vs.x * iw / (u_tanF * u_asp) + 1.0) * 0.5 * float(sz.x) - 0.5, (vs.y * iw / u_tanF + 1.0) * 0.5 * float(sz.y) - 0.5);
        int oy = int(floor(float(g_q.y) - sc.y + 0.5));
        int lean = e.w > 0.5 && oy >= 2 && sin(u_ptime * 1.5 - (qw.x * 0.8 + qw.y * 0.6) * 3.0) > 0.5 ? 1 : 0;   // (gusts over the lawn: tops lean a pixel)
        int ox = int(floor(float(g_q.x) - sc.x + 0.5)) - lean;
        if (hsf(ax, cz, 8, sd) < e.y) {   // (a clump: bigger, a step lighter, its top two, a dark line under it)
          if (oy == -1 && abs(ox) <= 2) shade = true;
          if (abs(ox) > 3 || oy < 0 || oy > 3 || oy <= best) continue;
          int m = CLUMPS[int(hsf(ax, cz, 6, sd) * 4.0) % 4], bit = oy * 7 + ox + 3; if (((m >> bit) & 1) == 0) continue;
          best = oy; col = rampAt(r, bb + (d > 0 ? (oy == 3 || ((m >> (bit + 7)) & 1) == 0 ? 2 : 1) : d)); continue; }
        if (oy == -1 && abs(ox) <= 1) shade = true;
        if (abs(ox) > 2 || oy < 0 || oy > 2 || oy <= best) continue;
        float hf = hsf(ax, cz, 5, sd); int fl = -1; if (nf > 0 && hf < F0.y) fl = 0; else if (nf > 1 && hf < F0.y + F1.x) fl = 1;
        int m = fl >= 0 ? 4548 : TUFTS[int(hsf(ax, cz, 6, sd) * 6.0) % 6];
        if (((m >> (oy * 5 + ox + 2)) & 1) == 0) continue;
        best = oy;
        if (fl == 0) col = int((ox == 0 && oy == 1 ? F0.z : F0.x) + 0.5); else if (fl == 1) col = int((ox == 0 && oy == 1 ? F1.y : F0.w) + 0.5);
        else col = rampAt(r, bb + (oy == 2 && d > 0 ? 2 : d)); }
      if (col >= 0) body = col; else if (shade) body = rampAt(r, bb - 1);
    }
    C.body = body; C.below = body; C.above = body; C.left = body; C.sel = ivec3(0, 0, 7);
  } else if (kind == 9) {   // needles: a conifer's tier lit as its cone, needle marks a step lighter, dark under the tier above
    int body = C.body; float fr; int L = nestL(p, fr); float mc = a.z * p * exp2(float(L)), mA = a.z * p * exp2(float(LMIN)); ivec3 mg = ivec3(floor(P / mc)); int best = -9; ivec2 sz = textureSize(u_idxTex, 0); mat3 V = mat3(u_pview);
    for (int kz = -1; kz <= 1; kz++) for (int ky = -1; ky <= 1; ky++) for (int kx = -1; kx <= 1; kx++) { ivec3 cL = mg + ivec3(kx, ky, kz); if (!shown3(cL, L, fr, sd)) continue; ivec3 c3 = atom3(cL, L, sd);
      if (hsf(c3.x, c3.y, c3.z, sd + 5) > a.y) continue;
      vec3 Q = (vec3(c3) + 0.15 + 0.7 * vec3(hsf(c3.x, c3.y, c3.z, sd), hsf(c3.x, c3.y, c3.z, sd + 1), hsf(c3.x, c3.y, c3.z, sd + 2))) * mA;
      if (dot(Q - P, Q - P) > mc * mc * 1.5) continue;
      vec3 vs = V * (Q - u_peye); float iw = u_portho > 0.5 ? 1.0 : 1.0 / max(-vs.z, 1e-6);
      vec2 sc = vec2((vs.x * iw / (u_tanF * u_asp) + 1.0) * 0.5 * float(sz.x) - 0.5, (vs.y * iw / u_tanF + 1.0) * 0.5 * float(sz.y) - 0.5);
      int ox = int(floor(float(g_q.x) - sc.x + 0.5)), oy = int(floor(float(g_q.y) - sc.y + 0.5));
      if (abs(ox) > 2 || oy < 0 || oy > 2 || oy <= best) continue;
      int m = NEEDLES[int(hsf(c3.x, c3.y, c3.z, sd + 6) * 4.0) % 4]; if (((m >> (oy * 5 + ox + 2)) & 1) == 0) continue;
      best = oy; body = rampAt(r, b + (b >= rlen(r) - 1 ? -1 : 1)); }
    C.body = body; C.below = body; C.left = body; C.above = rampAt(r, b - 2); C.key = ivec3(int(a.x + 0.5), 0, 9);
  } else if (kind == 10) {   // rock: plain stone with upright marks of cracks (two steps darker) and now and then a pebble of light
    int body = C.body; float fr; int L = nestL(p, fr); float mc = a.x * p * exp2(float(L)), mA = a.x * p * exp2(float(LMIN)); ivec3 mg = ivec3(floor(P / mc)); int best = -9; ivec2 sz = textureSize(u_idxTex, 0); mat3 V = mat3(u_pview);
    for (int kz = -1; kz <= 1; kz++) for (int ky = -1; ky <= 1; ky++) for (int kx = -1; kx <= 1; kx++) { ivec3 cL = mg + ivec3(kx, ky, kz); if (!shown3(cL, L, fr, sd)) continue; ivec3 c3 = atom3(cL, L, sd);
      if (hsf(c3.x, c3.y, c3.z, sd + 5) > a.y) continue;
      vec3 Q = (vec3(c3) + 0.15 + 0.7 * vec3(hsf(c3.x, c3.y, c3.z, sd), hsf(c3.x, c3.y, c3.z, sd + 1), hsf(c3.x, c3.y, c3.z, sd + 2))) * mA;
      if (dot(Q - P, Q - P) > mc * mc * 1.5) continue;
      vec3 vs = V * (Q - u_peye); float iw = u_portho > 0.5 ? 1.0 : 1.0 / max(-vs.z, 1e-6);
      vec2 sc = vec2((vs.x * iw / (u_tanF * u_asp) + 1.0) * 0.5 * float(sz.x) - 0.5, (vs.y * iw / u_tanF + 1.0) * 0.5 * float(sz.y) - 0.5);
      int ox = int(floor(float(g_q.x) - sc.x + 0.5)), oy = int(floor(float(g_q.y) - sc.y + 0.5));
      if (abs(ox) > 2 || oy < 0 || oy > 2 || oy <= best) continue;
      int mi = int(hsf(c3.x, c3.y, c3.z, sd + 6) * 4.0) % 4; if (((CRACKS[mi] >> (oy * 5 + ox + 2)) & 1) == 0) continue;
      best = oy; body = rampAt(r, b + (mi == 3 ? 1 : -2)); }
    C.body = body; C.below = body; C.above = body; C.left = body;
  } else if (kind == 8) {   // water: its own colour as it was made (shallows, foam), with ripples twinkling on it
    float fr; int L = nestL(p, fr); float cl = a.x * p * exp2(float(L)), cA = a.x * p * exp2(float(LMIN));
    C.body = -2; int ix = int(floor(P.x / cl)), iz = int(floor(P.z / cl)); C.sel = ivec3(0, 0, 8);
    ivec2 sz = textureSize(u_idxTex, 0); mat3 V = mat3(u_pview);
    for (int kz = -1; kz <= 1; kz++) for (int kx = -1; kx <= 1; kx++) { ivec2 c2 = ivec2(ix + kx, iz + kz); if (!shown2(c2, L, fr, sd)) continue;
      ivec2 at2 = atom2(c2, L, sd); int ax = at2.x, cz = at2.y;
      if (hsf(ax, cz, 4, sd) > a.y) continue; float ph = u_ptime * a.z + hsf(ax, cz, 7, sd); if (fract(ph) > 0.6) continue;
      vec3 vs = V * (vec3((float(ax) + 0.15 + 0.7 * hsf(ax, cz, 0, sd)) * cA, P.y, (float(cz) + 0.15 + 0.7 * hsf(ax, cz, 1, sd)) * cA) - u_peye); float iw = u_portho > 0.5 ? 1.0 : 1.0 / max(-vs.z, 1e-6);
      vec2 sc = vec2((vs.x * iw / (u_tanF * u_asp) + 1.0) * 0.5 * float(sz.x) - 0.5, (vs.y * iw / u_tanF + 1.0) * 0.5 * float(sz.y) - 0.5);
      int ox = int(floor(float(g_q.x) - sc.x + 0.5)), oy = int(floor(float(g_q.y) - sc.y + 0.5)), m = RIPPLES[int(hsf(ax, cz, 6, sd) * 4.0) % 4];
      if (abs(ox) <= 2 && oy >= 0 && oy <= 1 && ((m >> (oy * 5 + ox + 2)) & 1) != 0) { C.body = rampAt(r, b + 2); break; } }
    C.below = C.body; C.above = C.body; C.left = C.body;
  } else if (kind == 4) {   // grass: darker patches, tufts, flowers
    float ps = a.z, pn = sin(P.x / ps + 1.3 * sin(P.z / (ps * 1.7))) * sin(P.z / ps + 0.9 * sin(P.x / (ps * 1.3)));
    int bb = pn > 0.55 ? max(0, b - 1) : b; float cl = a.y * p; int ii = int(floor(P.x / cl)), kz = int(floor(P.z / cl));
    float h = hsf(ii, kz, 0, sd), cx = (float(ii) + 0.25 + 0.5 * hsf(ii, kz, 1, sd)) * cl, cz = (float(kz) + 0.25 + 0.5 * hsf(ii, kz, 2, sd)) * cl;
    float dx = (P.x - cx) / p, dz = (P.z - cz) / p, f = 0.0; int body = rampAt(r, bb); int nf = int(a.w + 0.5);
    vec4 F0 = u_patP[k * 4 + 1], F1 = u_patP[k * 4 + 2], F2 = u_patP[k * 4 + 3];
    float fc[3] = float[3](F0.y, F1.x, F1.w), fs[3] = float[3](F0.z, F1.y, F2.x), fm[3] = float[3](F0.w, F1.z, F2.y);
    bool done = false;
    for (int q = 0; q < 3; q++) { if (q >= nf || done) break; f += fs[q];
      if (h < f) { done = true; if (abs(dx) + abs(dz) < 1.1) body = int((abs(dx) < 0.5 && abs(dz) < 0.5 ? fm[q] : fc[q]) + 0.5); } }
    if (!done && h < f + a.x && abs(dz) < 0.6 && abs(dx) < 1.6) body = rampAt(r, bb + (bb >= rlen(r) - 2 ? -1 : 1));
    C.body = body; C.below = body; C.above = body; C.left = body; C.sel = ivec3(ii, kz, 4);
  }
  if (kind != 4 && kind != 7 && kind != 8) C.sel = C.key;
  return C; }
/* a pattern's detail, pinned to the world: stones, boards, tiles and thatch keep their real size at every zoom. Seen from far, where
   a screen pixel is bigger than the pattern's own, their seams go one by one: each cell joins its neighbour (along the course first,
   then course to course), each pair at its own moment as the camera draws back, so the stones merge and nothing moves; coming back in,
   the seams come back where they were. Points drawn as little pictures (tufts, marks, cracks, ripples) are pinned the same way,
   in nested sets (shown2/shown3). g_fp carries the size of a screen pixel on the surface to them */
ivec3 mergeKey(int kind, ivec3 k, int m) { if (m <= 0) return k;
  if (kind == 1) return ivec3(k.x, k.y >> max(0, m - 1), k.z >> (m + 1));   // stones: along the course first, then courses
  if (kind == 2) return ivec3(k.x >> max(0, m - 1), k.y >> m, k.z);          // boards: their ends first, then board to board
  if (kind == 3) return ivec3(k.x >> max(0, m - 1), k.y >> m, k.z);          // tiles: along the row, then rows
  if (kind == 6) return ivec3(k.x >> m, k.y, k.z);                           // thatch: course to course
  return k; }
Cell cellOf(int k, int r, vec3 P, vec3 n, vec3 fn, float t, float fp0) {
  /* (the level of detail is one for the whole picture, from the camera's distance alone: taken from each surface's slant it would
     differ from pixel to pixel, and change as the view turns, and the details would flicker) */
  float px0 = 1.0 / u_detail, fp = u_fpG; g_fp = fp;
  Cell C = cellAtL(k, r, P, n, fn, t, px0);
  if (C.key.x != -99999 && fp > px0) { int kind = int(u_patK4[k >> 2][k & 3] + 0.5); float lam = min(log2(fp / px0), 3.99); int m = int(floor(lam));
    ivec3 kn = mergeKey(kind, C.key, m + 1); C.key = hsf(kn.x, kn.y, kn.z, 4099) < lam - float(m) ? kn : mergeKey(kind, C.key, m); }
  return C; }
/* (smoothness: the cell of every pixel is worked out once, in a pass of its own (KEY_FS), and read here for the pixels round
   each one, instead of being worked out again for each of them) */
uniform highp isampler2D u_keyTex; uniform float u_keyOn;
ivec3 keyCalc(ivec2 q);
ivec3 keyAt(ivec2 q) { if (u_keyOn > 0.5) { ivec2 s = textureSize(u_keyTex, 0); if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) return ivec3(-99999);
    ivec4 k = texelFetch(u_keyTex, q, 0); return k.w == 1 ? k.xyz : ivec3(-99999); } return keyCalc(q); }
ivec3 keyCalc(ivec2 q) { g_q = q; int i = dabAt(q); if (i < 0) return ivec3(-99999); if ((int(texelFetch(u_dat,ivec2(((i & 511)<<2)+2,i>>9),0).w) & 32768) != 0) return ivec3(-99999); vec4 A = pixA(i); if (A.x < 0.5 || A.z < 0.5) return ivec3(-99999);
  vec4 Bq = pixB(i); vec3 n = vec3(A.w, Bq.x, Bq.y); vec4 h = hitOf(q, i, n); return cellOf(int(A.z + 0.5) - 1, int(A.x + 0.5) - 1, h.xyz, n, unfoldN(Bq.zw, n), 0.5, h.w).key; }
bool differs(ivec3 k, ivec3 q) { return q.x != -99999 && q != k; }
const ivec2 N4o[4] = ivec2[4](ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1)); bool g_pixed = false;
/* edge sprites (K.pixel.edge, an option): drawn first in a pass of their own (SPR_VS / SPR_FS: each stands on a point pinned to its
   surface), into u_sprLayer: which cell (8 + steps from the edge's own colour, or 100 + a palette colour), ramp and band */
uniform highp sampler2D u_sprLayer; uniform float u_sprOn, u_markA; bool g_spr = false;
${n?`uniform highp sampler2D u_materialStyles;
${yl}
float materialLight(float t, int id, int rampSize, ivec2 p) {
  int code = int(texelFetch(u_materialStyles, ivec2(id & 511, id >> 9), 0).y);
  int mode = code & 7, steps = (code >> 3) & 127;
  if (mode == 0 && steps == 0) return t;
  int bands = min(steps == 0 ? rampSize : steps, rampSize) - 1;
  if (bands < 1) return t;
  float level = clamp(t, 0.0, 1.0) * float(bands);
  return (mode == 0 ? floor(level + 0.5) :
    floor(level) + float(fract(level) > pixelStyleThreshold(mode, p))) / float(bands);
}
`:""}
${y?y.indexedGLSL:""}
vec3 pixColour(ivec2 p, vec3 c) {
  int i = dabAt(p); if (i < 0) return c;
  if ((int(texelFetch(u_dat,ivec2(((i & 511)<<2)+2,i>>9),0).w) & 32768) != 0) return c; vec4 A = pixA(i); if (A.x < 0.5) return c;
  // (only where the dab is what shows: nothing soft in front of it, no light carried onto it)
  vec4 t1 = texelFetch(u_dat, ivec2(((i & 511) << 2) + 1, i >> 9), 0); float pk = t1.w;
  vec3 baked = vec3(mod(pk, 256.0), mod(floor(pk / 256.0), 256.0), floor(pk / 65536.0)) / 255.0;
${p?`
  vec4 gain = relightAt(i);
  float fogAmount = 0.0;
  if (gain.w > 0.0) {
    if (u_relightFogRange.x < 1.0 && u_relightFogRange.y > 0.0)
      fogAmount = smoothstep(u_relightFogRange.x, 1.0, texelFetch(u_depth, p, 0).r) * u_relightFogRange.y;
    baked = mix(min(vec3(1.0), baked * gain.rgb), u_relightFog, fogAmount);
  }`:""}
${t||u?`
  vec3 center = texelFetch(u_dat, ivec2((i & 511) << 2, i >> 9), 0).xyz;
  float axial = ${t?"-(u_waterView * vec4(center, 1.0)).z":"dot(u_envEye-center,u_envBack)"};
  vec2 size = vec2(textureSize(u_scene, 0));`:""}
${t?`  vec3 mark;
  baked = waterPaint(baked, vec2(p) + 0.5, size, axial, mark);`:""}
${u?"  baked = envMedia(baked, vec2(p) + 0.5, size, axial);":""}
  if (max(abs(baked.r - c.r), max(abs(baked.g - c.g), abs(baked.b - c.b))) > 0.03) return c;
  int r = int(A.x + 0.5) - 1; float dc = texelFetch(u_depth, p, 0).r, sum = 0.0, cnt = 0.0;
  vec4 Bq = pixB(i); vec3 n = vec3(A.w, Bq.x, Bq.y);
  /* the light, smoothed over the same surface round the pixel (the same ramp, near in depth): over three by three; with the light
     shaper (an option), over seven by seven and only where the surface faces much the same way, so the light and the shade fall in a
     few big shapes with smooth edges, not wherever the light of each dab happens to cross a step */
  // (near the edge of a surface the big window is cut in half, and its mean would pull a lit rim toward the middle, shading that
  // follows the outline: there the three by three is kept, and the two are blended by how much of the big window is surface)
  bool shp = u_shape > 0.5; float s7 = 0.0, c7 = 0.0;
  for (int dy = -3; dy <= 3; dy++) for (int dx = -3; dx <= 3; dx++) { bool small = abs(dx) <= 1 && abs(dy) <= 1, wide = shp && ((dx + dy) & 1) == 0; if (!small && !wide) continue;
    ivec2 q = p + ivec2(dx, dy); int j = dabAt(q); if (j < 0) continue; vec4 Aj = pixA(j);
    if (abs(Aj.x - A.x) > 0.5 || abs(texelFetch(u_depth, q, 0).r - dc) > 0.03) continue;
    if (small) { sum += Aj.y; cnt += 1.0; }
    if (wide) { vec4 Bj = pixB(j); if (dot(n, vec3(Aj.w, Bj.x, Bj.y)) >= 0.8) { s7 += Aj.y; c7 += 1.0; } } }
  float t = cnt > 0.0 ? sum / cnt : A.y;
  if (shp && c7 > 0.0) t = mix(t, s7 / c7, smoothstep(0.5, 0.85, c7 / 25.0));
  ${n?"t = materialLight(t, i, rlen(r), p);":""}
  int ci;
  if (A.z < 0.5) ci = rampAt(r, bandOf(r, t));
  else { vec4 h = hitOf(p, i, n); g_q = p; Cell C = cellOf(int(A.z + 0.5) - 1, r, h.xyz, n, unfoldN(Bq.zw, n), t, h.w); ci = C.body;
    if (C.key.x != -99999) { if (differs(C.key, keyAt(p - ivec2(0, 1)))) ci = C.below; else if (differs(C.key, keyAt(p - ivec2(1, 0)))) ci = C.left; else if (differs(C.key, keyAt(p + ivec2(0, 1)))) ci = C.above; } }
  if (ci == -2) return c;   // (a pattern that keeps the colour the dab was made with, here and there drawn over)
  /* outlines (look.outline): at the edge of a thing, where it meets another material, the background or something well behind it,
     the nearer pixel takes a darker step of its own ramp, so each thing is ringed in its own darker colour (a lit one more softly) */
  if (u_ol > 0.5 && !lineOff(r) && dc > -0.5) { bool edge = false, sky = false;
    ivec2 omx = textureSize(u_depth, 0) - 1;
    for (int k = 0; k < 4; k++) { ivec2 q = p + N4o[k]; if (texelFetch(u_depth, q, 0).r < -0.5) continue; float dd = texelFetch(u_depth, q, 0).r - dc; if (dd <= u_olEps) continue;
      // (a break must carry on past the next pixel or two: a hole in a surface, where what lies under it shows through, is not an edge)
      if (texelFetch(u_depth, clamp(p + 2 * N4o[k], ivec2(0), omx), 0).r - dc <= u_olEps || texelFetch(u_depth, clamp(p + 3 * N4o[k], ivec2(0), omx), 0).r - dc <= u_olEps) continue;
      int j = dabAt(q); if (j < 0 || dd > u_olGap) { edge = true; sky = sky || texelFetch(u_depth, q, 0).r >= 0.995; break; } vec4 Aj = pixA(j); if (!sameStuff(int(Aj.x + 0.5) - 1, r)) { edge = true; break; } }
    // (and a crease: where its own surface turns sharply, the lit side a step lighter, the other a step darker; not in leaves or grass)
    int ck = 0; bool soft = false; if (A.z > 0.5) { int kk = int(A.z + 0.5) - 1; int kd = int(u_patK4[kk >> 2][kk & 3] + 0.5); soft = kd == 5 || kd == 7; }
    if (!edge && !soft) for (int k = 0; k < 4; k++) { ivec2 q = p + N4o[k]; int j = dabAt(q); if (j < 0) continue; vec4 Aj = pixA(j);
      if (abs(Aj.x - A.x) > 0.5 || abs(texelFetch(u_depth, q, 0).r - dc) > u_olGap) continue; vec4 Bj = pixB(j);
      if (dot(n, vec3(Aj.w, Bj.x, Bj.y)) > 0.7) continue; ck = A.y >= Aj.y ? 1 : -1; break; }
    if (edge || ck != 0) { int bb = -1; for (int k = 0; k < 8; k++) { if (k >= rlen(r)) break; if (rampAt(r, k) == ci) { bb = k; break; } }
      // (a rim in the light takes a softer line than one in shade, or none against another thing: so the outline does not darken a
      // shape all round, whichever way it faces, which is pillow shading)
      int kk2 = bb * 2 >= rlen(r) ? (sky ? 1 : 0) : u_olK;
      if (bb >= 0) ci = rampAt(r, edge ? max(0, bb - kk2) : bb + ck); } }
  g_pixed = true;
  vec3 surfaceColor = u_pal[clamp(ci, 0, u_n - 1)];
  ${y?`vec2 facingSize = vec2(textureSize(u_idxTex, 0));
  surfaceColor = facingIndexed(surfaceColor, i, u_dat, u_ptime, u_pview, vec2(p) + 0.5,
    facingSize, facingSize.y / (2.0 * u_tanF), u_portho > 0.5);`:""}
  ${p?"if (gain.w > 0.0) surfaceColor = mix(min(vec3(1.0), surfaceColor * gain.rgb), u_relightFog, fogAmount);":""}
  ${t?"surfaceColor = waterPaint(surfaceColor,vec2(p)+0.5,size,axial,mark);":""}
  ${u?"surfaceColor = envMedia(surfaceColor,vec2(p)+0.5,size,axial);":""}
  return surfaceColor; }
const int GPET[12] = int[12](0, 3, 1, 4, 0, 3, 2, 4, 0, 3, 1, 4); const int GOUT[6] = int[6](3, 1, 4, 2, 0, 1);
vec3 glassPane(vec2 q) {
  float r = length(q) / u_gw.w * 2.6, a = fract(atan(q.y, q.x) / 6.2831853 + 1.0);
  if (r > 2.52) return vec3(0.0); if (r < 0.5) return u_gc[5]; if (r < 0.64) return vec3(0.0);
  if (r < 1.72) { float s = a * 12.0, k = floor(s), f = s - k, w = 0.07 / r; if (f < w || f > 1.0 - w) return vec3(0.0); if (r > 1.2 && abs(f - 0.5) > 0.5 - (r - 1.2) * 0.75) return vec3(0.0); return r < 0.98 ? u_gc[5] : u_gc[GPET[int(k) % 12]]; }
  if (r < 1.86) return vec3(0.0); float s = a * 24.0 + 0.5, k = floor(s), f = s - k; if (f < 0.07 || f > 0.93) return vec3(0.0);
  return length(vec2((f - 0.5) * 0.6, (r - 2.19) * 1.25)) < 0.36 ? u_gc[GOUT[int(k) % 6]] : vec3(0.0);
}
float glassHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float glassHaze(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(glassHash(i), glassHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(glassHash(i + vec3(0.0, 1.0, 0.0)), glassHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(glassHash(i + vec3(0.0, 0.0, 1.0)), glassHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(glassHash(i + vec3(0.0, 1.0, 1.0)), glassHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z); }
// sunlight through gaps in a canopy (a diorama's .glass with mode 'gaps', from K.dapple): each gap lets down a shaft along the light. A line
// of sight lights up by how much of a shaft it passes through, but only until it is well inside: a shaft is a flat, even band of light.
// Four looks along the part it passes through say how strong the band is there: it eases in just under its gap, thins as it goes down,
// is thicker where the haze drifts, and fades out toward the ground and toward the edge of the stand (the diorama's .glass at and r), so
// a shaft never ends on a hard line whatever it is seen from. With steps, the light is banded into that many levels, dithered only where
// one level gives way to the next, so a shaft is drawn as flat pixel tones are, with a stippled edge
uniform float u_gm, u_gq, u_gfl; uniform vec4 u_gh[24]; uniform int u_ghn;
vec3 glassGaps(vec3 c, ivec2 p, float dn, vec2 res) {
  vec2 ndc = (vec2(p) + 0.5) / res * 2.0 - 1.0; vec3 rv = u_gortho > 0.5 ? vec3(0.0, 0.0, -1.0) : normalize(vec3(ndc.x * u_gcam.x, ndc.y * u_gcam.y, -1.0)), dir = transpose(mat3(u_gview)) * rv;
  vec3 ge = u_gortho > 0.5 ? u_geye + transpose(mat3(u_gview)) * vec3(ndc.x * u_gcam.x, ndc.y * u_gcam.y, 0.0) : u_geye;   // (orthographic: parallel lines of sight)
  // (where nothing is drawn the line of sight goes on through the air: it is not stopped at the far side of the stand)
  float tmax = dn >= 0.999 ? 1e4 : (u_gcam.z + min(dn, 1.0) * (u_gcam.w - u_gcam.z)) / max(-rv.z, 0.05), sw = 0.0; vec3 sc = vec3(0.0);
  for (int i = 0; i < 24; i++) { if (i >= u_ghn) break;
    vec4 h = u_gh[i]; vec3 hc = h.xyz + vec3(sin(u_gtime * 0.7 + float(i) * 1.7), 0.0, cos(u_gtime * 0.6 + float(i) * 2.3)) * 0.05 * h.w;
    vec3 oc = ge - hc; float dd = dot(dir, u_gd), od = dot(oc, u_gd), A = 1.0 - dd * dd, Bq = dot(oc, dir) - od * dd, C = dot(oc, oc) - od * od - h.w * h.w, disc = Bq * Bq - A * C;
    if (A < 1e-5 || disc <= 0.0) continue;
    float sq = sqrt(disc), t0 = max((-Bq - sq) / A, 0.0), t1 = min((-Bq + sq) / A, tmax), lo = u_gfl - 0.6;
    if (abs(dir.y) > 1e-5) { float ty = (hc.y - ge.y) / dir.y, tf = (lo - ge.y) / dir.y; if (dir.y < 0.0) { t0 = max(t0, ty); t1 = min(t1, tf); } else { t0 = max(t0, tf); t1 = min(t1, ty); } }
    else if (ge.y > hc.y || ge.y < lo) continue;
    if (t1 <= t0) continue;
    float f = 0.0;
    for (int k = 0; k < 4; k++) { vec3 Q = ge + dir * mix(t0, t1, (float(k) + 0.5) / 4.0); float s = (hc.y - Q.y) / max(-u_gd.y, 0.05);
      f += smoothstep(0.0, 0.9, s) * smoothstep(lo, u_gfl + 0.6, Q.y) * (1.0 - smoothstep(u_gw.w * 0.72, u_gw.w, length(Q.xz - u_gw.xz))) * exp(-s * 0.09)
         * (0.8 + 0.45 * glassHaze(Q * 0.6 + vec3(u_gtime * 0.11, -u_gtime * 0.05, u_gtime * 0.07))); }
    float w = min(1.0, (t1 - t0) / (0.6 * h.w)) * f * 0.25 * (0.88 + 0.12 * sin(u_gtime * 1.3 + float(i) * 2.1));
    sc += u_gc[i - (i / 6) * 6] * w; sw += w; }
  if (sw <= 0.0) return c;
  vec3 col = sc / sw; float a = min(sw, 1.6);
  if (u_gq > 0.0) { float th = (BAYER[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0 - 0.5; a = floor(a * u_gq + 0.5 + th * 0.5) / u_gq; }   // (stippled only near a level's edge)
  return c + col * a * u_gk;
}
vec3 glassAir(vec3 c, ivec2 p, float dn, vec2 res) {
  if (u_gk <= 0.0) return c;
  if (u_gm > 0.5) return glassGaps(c, p, dn, res);
  vec2 ndc = (vec2(p) + 0.5) / res * 2.0 - 1.0; vec3 rv = u_gortho > 0.5 ? vec3(0.0, 0.0, -1.0) : normalize(vec3(ndc.x * u_gcam.x, ndc.y * u_gcam.y, -1.0)), dir = transpose(mat3(u_gview)) * rv;
  vec3 ge = u_gortho > 0.5 ? u_geye + transpose(mat3(u_gview)) * vec3(ndc.x * u_gcam.x, ndc.y * u_gcam.y, 0.0) : u_geye;   // (orthographic: parallel lines of sight)
  float tmax = (u_gcam.z + min(dn, 1.0) * (u_gcam.w - u_gcam.z)) / max(-rv.z, 0.05);
  vec3 oc = ge - u_gw.xyz; float dd = dot(dir, u_gd), od = dot(oc, u_gd), A = 1.0 - dd * dd, Bq = dot(oc, dir) - od * dd, C = dot(oc, oc) - od * od - u_gw.w * u_gw.w, disc = Bq * Bq - A * C;
  if (A < 1e-5 || disc <= 0.0) return c;
  float sq = sqrt(disc), t0 = max((-Bq - sq) / A, 0.0), t1 = min((-Bq + sq) / A, tmax), tm = -Bq / A, tw = 0.3 * sq / A; if (t1 <= t0) return c;
  // (the middle of the beam counts for most: what is seen is mainly the row of panes straight through its axis, drawn out along the light, so the
  // shafts keep their own colours side by side; the rest of the depth adds a little of everything, which is the haze)
  float jit = fract(52.9829189 * fract(dot(vec2(p), vec2(0.06711056, 0.00583715)))), dt = (t1 - t0) / 32.0, T = 1.0; vec3 sc = vec3(0.0);
  for (int i = 0; i < 32; i++) { vec3 P = ge + dir * (t0 + (float(i) + jit) * dt); float s = (P.z - u_gw.z) / u_gd.z; if (s < 0.05 || P.y < -0.05) continue;
    float dens = (0.45 + 1.0 * glassHaze(P * 0.5 + vec3(u_gtime * 0.07, -u_gtime * 0.04, u_gtime * 0.05))) * exp(-s * 0.02);
    float tt = (t0 + (float(i) + jit) * dt - tm) / tw; sc += T * glassPane(P.xy - u_gd.xy * s - u_gw.xy) * dens * dt * (0.22 + 1.9 * exp(-tt * tt)); T *= exp(-dens * dt * 0.03); }
  float lum = dot(sc, vec3(0.3, 0.55, 0.15)); sc = max(vec3(0.0), mix(vec3(lum), sc, 1.45));
  return c * mix(1.0, T, 0.7) + sc * u_gk;
}
// with coloured contours on, the inside of things comes from the picture drawn at its own size: glass bends that picture and contact shade
// darkens it here, exactly as they do in the plain look below
#define PIXEL_NATIVE
vec3 pixelNative(ivec2 p) {
  ivec2 mx = textureSize(u_crispDepth, 0) - 1; vec3 c = texelFetch(u_crispScene, p, 0).rgb; vec4 dm = texelFetch(u_crispDepth, p, 0);
  vec2 gg = vec2(texelFetch(u_crispDepth, clamp(p + ivec2(1, 0), ivec2(0), mx), 0).g - texelFetch(u_crispDepth, clamp(p - ivec2(1, 0), ivec2(0), mx), 0).g, texelFetch(u_crispDepth, clamp(p + ivec2(0, 1), ivec2(0), mx), 0).g - texelFetch(u_crispDepth, clamp(p - ivec2(0, 1), ivec2(0), mx), 0).g);
  if (dm.g + abs(gg.x) + abs(gg.y) > 0.0) c = texelFetch(u_crispScene, clamp(p + ivec2(round(gg * u_refract)), ivec2(0), mx), 0).rgb;
  if (u_ao > 0.0) { float occ = 0.0; for (int i = 0; i < 8; i++) { float dd = (dm.r - texelFetch(u_crispDepth, clamp(p + AOT[i], ivec2(0), mx), 0).r) / u_aor; if (dd > 0.08 && dd < 3.0) occ += min(1.0, dd); } c *= 1.0 - u_ao * min(1.0, occ / 4.0); }
  return c;
}
${d?`
uniform highp sampler2D u_glassBoundary, u_glassBack, u_glassThrough;
uniform vec2 u_glassRange;
uniform mat4 u_glassProjection;
float glassDepth(vec4 info) {
  return dot(floor(info.rgb*255.0+0.5),vec3(1.0,256.0,65536.0)) / 16777215.0;
}
vec3 refractContributions(ivec2 p, vec3 color) {
  vec4 front=texelFetch(u_glassBoundary,p,0);
  if (front.a==0.0) return color;
  float through=texelFetch(u_glassThrough,p,0).r;
  if (through<=0.0 || texelFetch(u_depth,p,0).g==0.0) return color;
  ivec2 mx=textureSize(u_depth,0)-1;
  vec2 delta=vec2(texelFetch(u_depth,clamp(p+ivec2(1,0),ivec2(0),mx),0).g-texelFetch(u_depth,clamp(p-ivec2(1,0),ivec2(0),mx),0).g,
    texelFetch(u_depth,clamp(p+ivec2(0,1),ivec2(0),mx),0).g-texelFetch(u_depth,clamp(p-ivec2(0,1),ivec2(0),mx),0).g);
  ivec2 source=clamp(p+ivec2(round(delta*u_refract)),ivec2(0),mx);
  if (all(equal(source,p))) return color;
  bool rear=texelFetch(u_glassBoundary,source,0).a>0.0;
  if (!rear) {
    float axial=mix(u_glassRange.x,u_glassRange.y,texelFetch(u_depth,source,0).r);
    vec4 clip=u_glassProjection*vec4(0.0,0.0,-axial,1.0);
    if (clip.z/clip.w*0.5+0.5 < glassDepth(front)) return color;
  }
  vec3 shifted=rear?texelFetch(u_glassBack,source,0).rgb:texelFetch(u_scene,source,0).rgb;
  return clamp(color + (shifted-texelFetch(u_glassBack,p,0).rgb)*through,0.0,1.0);
}`:""}
${e.glsl}
${T?Cu:""}
${r?Op(c,T):""}
${F?C:""}
// a hole a pixel across in a surface (its dabs, seen nearly edge on, leave gaps, and what lies under it or far behind shows through, as
// dark broken lines across the ground): it is drawn as the nearer of the pixels either side of it, which lie on the surface
ivec2 holeFill(ivec2 p) { ivec2 ms = textureSize(u_depth, 0) - 1; float d0 = texelFetch(u_depth, p, 0).r;
  ${F?"if (protectedGap(u_idxTex, u_depth, p)) return p;":""}
  // (colour per pixel knows which dab is in front at each pixel: a pixel with none, between two that have one, is a hole whatever the
  // depths say: dabs left out of outlines write none)
  if (${f?"u_pixOn > 0.5":"false"} && dabAt(p) < 0) for (int ax = 0; ax < 2; ax++) { ivec2 o = ax == 0 ? ivec2(0, 1) : ivec2(1, 0); if (dabAt(p + o) >= 0 && dabAt(p - o) >= 0) return p + o; }
  for (int ax = 0; ax < 2; ax++) { ivec2 o = ax == 0 ? ivec2(0, 1) : ivec2(1, 0), qa = clamp(p + o, ivec2(0), ms), qb = clamp(p - o, ivec2(0), ms);
    float da = texelFetch(u_depth, qa, 0).r, db = texelFetch(u_depth, qb, 0).r, gap = d0 - max(da, db);
    if (min(d0, min(da, db)) > -0.5 && gap > 0.004 && abs(da - db) < 0.6 * gap) return da < db ? qa : qb; }
  return p; }
vec3 toneAt(vec3 c, ivec2 p) {
    float lu = dot(c, vec3(0.30, 0.55, 0.15)); if (lu <= u_toneCut) return vec3(0.0);
    float v = (lu - u_toneCut) / (1.0 - u_toneCut); int lo = 0; for (int i = 0; i < 46; i++) { if (lo >= u_toneN - 2 || v <= texelFetch(u_toneStops, ivec2(lo + 1, 0), 0).a) break; lo++; }
    vec4 s0 = texelFetch(u_toneStops, ivec2(lo, 0), 0), s1 = texelFetch(u_toneStops, ivec2(lo + 1, 0), 0); ivec2 th = ${_?"u_toneThSize":"textureSize(u_toneTh, 0)"}, sz = textureSize(u_depth, 0);
    ivec2 screen=ivec2(p.x,sz.y-1-p.y);
    ivec2 rankAt=${T?"positiveGrid(markCoordinates(p,screen),th)":"screen%th"};
    float share = (v - s0.a) / max(1e-5, s1.a - s0.a),
      rank = ${_?"texelFetch(u_toneStops, rankAt + ivec2(0, 1), 0).r":"texelFetch(u_toneTh, rankAt, 0).r"};
    return share >= 0.5 + (rank - 0.5) * u_toneAmt ? s1.rgb : s0.rgb; }
// the finished colour of one pixel of the picture, in whichever look is on
vec3 plainAt(ivec2 p) {
  ivec2 artPixel = p;
  p = holeFill(p);
  vec3 c = texelFetch(u_scene, p, 0).rgb;
  ${d?"c = refractContributions(p,c);":""}
  g_pixed = false;
  if (${f?"u_pixOn > 0.5":"false"}) { if (u_sprOn > 0.5) {
${t||u||p?"      vec4 sl = texelFetch(u_sprLayer, p, 0); if (sl.a > 0.5) { g_spr = true; g_pixed = true; return u_toneOn > 0.5 ? toneAt(sl.rgb, artPixel) : sl.rgb; }":"      vec4 sl = texelFetch(u_sprLayer, p, 0) * 255.0; if (sl.a > 127.0) { int v = int(sl.r + 0.5), ci = v >= 100 ? v - 100 : rampAt(int(sl.g + 0.5), int(sl.b + 0.5) + v - 8); g_spr = true; g_pixed = true; vec3 color = u_pal[clamp(ci, 0, u_n - 1)]; return u_toneOn > 0.5 ? toneAt(color, artPixel) : color; }"} }
    if (${E?"u_paintOn":"false"}) {
      vec3 paint = texelFetch(u_crispScene, p, 0).rgb;
      float through = 1.0 - texelFetch(u_crispDepth, p, 0).r;
      if (through > 0.01) {
        vec3 base = pixColour(p, clamp((c - paint) / through, 0.0, 1.0));
        if (g_pixed) c = paint + base * through;
      }
    } else c = pixColour(p, c);
  }
  // outline: this pixel sits clearly behind a neighbour, so it is the edge of something nearer
  ivec2 mx = textureSize(u_depth, 0) - 1;
  float dc = texelFetch(u_depth, p, 0).r;
  float dl = texelFetch(u_depth, clamp(p - ivec2(1, 0), ivec2(0), mx), 0).r, dr = texelFetch(u_depth, clamp(p + ivec2(1, 0), ivec2(0), mx), 0).r;
  float du = texelFetch(u_depth, clamp(p + ivec2(0, 1), ivec2(0), mx), 0).r, db = texelFetch(u_depth, clamp(p - ivec2(0, 1), ivec2(0), mx), 0).r;
  // glass bends what is behind it: the picture is looked up a little to one side, by how the thickness of glass changes across this pixel
  ${l?"":`{ vec2 gg = vec2(texelFetch(u_depth, clamp(p + ivec2(1, 0), ivec2(0), mx), 0).g - texelFetch(u_depth, clamp(p - ivec2(1, 0), ivec2(0), mx), 0).g, texelFetch(u_depth, clamp(p + ivec2(0, 1), ivec2(0), mx), 0).g - texelFetch(u_depth, clamp(p - ivec2(0, 1), ivec2(0), mx), 0).g);
    if (texelFetch(u_depth, p, 0).g + abs(gg.x) + abs(gg.y) > 0.0) c = texelFetch(u_scene, clamp(p + ivec2(round(gg * u_refract)), ivec2(0), mx), 0).rgb; }`}
  // where a diorama asks for it, a pixel with nearer things close round it is shaded: what moves still sits in its own shadow
  if (u_ao > 0.0) { float occ = 0.0;
    for (int i = 0; i < 8; i++) { float dd = (dc - texelFetch(u_depth, clamp(p + AOT[i], ivec2(0), mx), 0).r) / u_aor; if (dd > 0.08 && dd < 3.0) occ += min(1.0, dd); } c *= 1.0 - u_ao * min(1.0, occ / 4.0); }
  // part lines (a diorama's look.lines): the near side of a break in depth takes a darker shade of its own colour, or a lighter one
  // where the break is toward the light (up or to the left), as pixel art outlines a thing. (Second differences, so a floor that
  // only recedes is not a break)
  float dl2 = texelFetch(u_depth, clamp(p - ivec2(2, 0), ivec2(0), mx), 0).r, dr2 = texelFetch(u_depth, clamp(p + ivec2(2, 0), ivec2(0), mx), 0).r;
  float du2 = texelFetch(u_depth, clamp(p + ivec2(0, 2), ivec2(0), mx), 0).r, db2 = texelFetch(u_depth, clamp(p - ivec2(0, 2), ivec2(0), mx), 0).r;
  // (a dab left out of outlines writes no depth, -1: a neighbour like that is taken as level with this pixel, and such a pixel takes
  // no line, so where one ground that is left out meets one that is not, no line runs along the seam)
  if (dl < -0.5) dl = dc; if (dr < -0.5) dr = dc; if (du < -0.5) du = dc; if (db < -0.5) db = dc; if (dl2 < -0.5) dl2 = dc; if (dr2 < -0.5) dr2 = dc; if (du2 < -0.5) du2 = dc; if (db2 < -0.5) db2 = dc;
  // (a break in depth must show two pixels out as well as one: a hole in a surface, a pixel wide, where what lies under it shows
  // through, is not the edge of anything)
  if (u_lines > 0.0 && dc > -0.5 && !(g_pixed && u_ol > 0.5)) { float sx = min(dl + dr, dl2 + dr2) - 2.0 * dc, sy = min(du + db, du2 + db2) - 2.0 * dc;
    if (max(sx, sy) > u_lineGap) { bool litSide = sx >= sy ? dl > dr : du > db; c *= litSide ? u_lineLit : u_lineK; } }
  float dm = dc - max(2.0 * dc - min(dl + dr, dl2 + dr2), 2.0 * dc - min(du + db, du2 + db2));   // second difference, so a receding floor is not an edge
  if (u_edge > 0.0 && dc > -0.5 && dc - dm > u_edge) {
    if (u_remapLine > 0) return glassAir(u_out[u_remapLine - 1], p, dc, vec2(textureSize(u_depth, 0)));
    c = u_line;
    if (u_toneOn > 0.5) return toneAt(c, artPixel);
  }
  ${l?"return glassAir(c, p, dc, vec2(textureSize(u_depth, 0)));":""}
  ${l?"":"else {"}
${r?"    vec3 constrained; if (constrainPalette(p, c, constrained)) { g_constrained = true; return constrained; }":""}
    if (u_toneOn > 0.5) return toneAt(c, artPixel);
    ivec2 grid=${T?"markCoordinates(p,artPixel)":"p"};
    float th = (BAYER[(grid.x & 3) + ((grid.y & 3) << 2)] + 0.5) / 16.0 - 0.5;
    c = clamp(c + th * u_dither, 0.0, 1.0);
  ${l?"":"}"}
  vec3 best = u_pal[0]; float bd = 1e9; int bi = 0;
  for (int i = 0; i < u_pal.length(); i++) {
    if (i >= u_n) break;
    vec3 df = c - u_pal[i];
    float d = u_luma > 0.5 ? abs(dot(df, vec3(0.299, 0.587, 0.114))) : dot(df * df, vec3(0.30, 0.55, 0.15));
    if (d < bd) { bd = d; best = u_pal[i]; bi = i; }
  }
  bool lit = texelFetch(u_depth, p, 0).b > 0.3 + ((BAYER[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0 - 0.5) * 0.3;
  return glassAir(u_grade > 0.5 ? (lit ? u_outl[bi] : u_out[bi]) : best, p, dc, vec2(textureSize(u_depth, 0)));
}
bool like(vec3 a, vec3 b) { vec3 d = abs(a - b); return max(d.r, max(d.g, d.b)) < 0.004; }
vec3 lookAt(ivec2 p) {
  if (${x?"u_colored > 0.5":"false"}) {
${r?"    vec3 constrained; if (constrainPalette(p, pixelNative(p), constrained)) { g_constrained = true; return constrained; }":""}
    vec3 c = pixelResolve(p); vec4 dq = texelFetch(u_crispDepth, p, 0);
    if (u_grade > 0.5 && dq.b > 0.3 + ((BAYER[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0 - 0.5) * 0.3) { for (int j = 0; j < u_out.length(); j++) { if (j >= u_n) break; if (like(c, u_out[j])) { c = u_outl[j]; break; } } }   // under a carried light
    return glassAir(c, p, dq.r, vec2(textureSize(u_crispScene, 0))); }
  return plainAt(p);
}
float depthAt(ivec2 p) { return ${x?"u_colored > 0.5":"false"} ? texelFetch(u_crispDepth, p, 0).r : texelFetch(u_depth, p, 0).r; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_bars > 0.0 && abs(gl_FragCoord.y / float(textureSize(${x?"u_crispScene":"u_scene"}, 0).y) - 0.5) > 0.5 - u_bars) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }   /* letterbox bars, when a diorama asks for them */
${t?"  p = waterPixel(p);":""}
  if (u_bypass > 0.5) { o = vec4(texelFetch(u_scene, p, 0).rgb, 1.0); return; }
  vec3 c0 = lookAt(p);
  o = vec4(c0, (g_spr${r?" || g_constrained":""}) && u_markA > 0.5 ? 0.5 : 1.0);
}`,g=`#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_look, u_dep;
uniform highp sampler2D u_detailOwners;
uniform float u_keep, u_lineClean;
uniform bool u_scopedOnly, u_hasDetailFlags, u_detailWater, u_protectGaps;
out vec4 o;
${R}
${C}
bool like(vec3 a, vec3 b) { vec3 d = abs(a - b); return max(d.r, max(d.g, d.b)) < 0.004; }
vec3 at(ivec2 p) { return texelFetch(u_look, clamp(p, ivec2(0), textureSize(u_look, 0) - 1), 0).rgb; }
float dp(ivec2 p) { ivec2 q = clamp(p, ivec2(0), textureSize(u_dep, 0) - 1); return texelFetch(u_look, q, 0).a < 0.75 ? 0.5 : texelFetch(u_dep, u_detailWater ? waterPixel(q) : q, 0).r; }
const ivec2 N8[8] = ivec2[8](ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1), ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1), ivec2(1, 1));
int detailFlags(ivec2 p) {
  return u_hasDetailFlags ? detailAt(u_detailOwners, u_detailWater ? waterPixel(p) : p) : 0;
}
bool protects(int flags) { return (flags & 6) != 0; }
int likes(ivec2 p, vec3 c, out ivec2 one) { int n = 0; one = p; for (int i = 0; i < 8; i++) if (like(c, at(p + N8[i]))) { n++; one = p + N8[i]; } return n; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); vec3 c0 = at(p); ivec2 q, q2;
  float alpha = texelFetch(u_look, p, 0).a;
  int flags = detailFlags(p);
  if (alpha < 0.75 || (flags & 2) != 0 || (u_scopedOnly && (flags & 1) == 0)) {
    o = vec4(c0, 1.0); return;
  }
  if (u_protectGaps && protectedGap(u_detailOwners, u_dep, u_detailWater ? waterPixel(p) : p)) {
    o = vec4(c0, 1.0); return;
  }
  // outlines: a notch (an empty pixel with things on three or four sides) is filled from them, a bump (a pixel of a thing with
  // nothing on three or four sides) is taken off, so the edge of a thing against the background runs clean
  { bool e0 = dp(p) >= 0.995; int en = 0;
    for (int i = 0; i < 4; i++) {
      ivec2 q = clamp(p + N8[i], ivec2(0), textureSize(u_look, 0) - 1);
      if (dp(q) >= 0.995) en++;
      if (u_hasDetailFlags && (e0 || (flags & 8) == 0) &&
          protects(detailFlags(q))) { o = vec4(c0, 1.0); return; }
    }
    if (!e0 && en > 0 && protects(flags)) { o = vec4(c0, 1.0); return; }
    if (e0 && en <= 1) { int kb = 0, ib = -1; for (int i = 0; i < 4; i++) { if (dp(p + N8[i]) >= 0.995) continue; int k = 0; for (int j = 0; j < 4; j++) if (like(at(p + N8[i]), at(p + N8[j]))) k++; if (k > kb) { kb = k; ib = i; } }
      if (ib >= 0) { o = vec4(at(p + N8[ib]), 1.0); return; } }
    if (!e0 && en >= 3) { for (int i = 0; i < 4; i++) if (dp(p + N8[i]) >= 0.995) { o = vec4(at(p + N8[i]), 1.0); return; } } }
  /* the line cleaner (an option): a one-pixel kink in a straight edge between two colours is taken off (a pixel with one colour across
     from it and on both sides, its own colour carrying on straight behind it, takes the other colour: a bump, or a dent, filled);
     and on a dark line one pixel thick, the extra pixel at the inside corner of a step (a double) takes the colour beside it, so the
     line meets corner to corner as a pixel artist draws it */
  if (u_lineClean > 0.5) {
    for (int k = 0; k < 4; k++) { ivec2 d = N8[k], e = ivec2(d.y, d.x); vec3 X = at(p + d);
      if (like(X, c0) || !like(at(p + e), X) || !like(at(p - e), X)) continue;
      if (like(at(p - d), c0) && like(at(p - d + e), c0) && like(at(p - d - e), c0)) { o = vec4(X, 1.0); return; } }
    float l0 = dot(c0, vec3(0.3, 0.55, 0.15));
    for (int k = 4; k < 8; k++) { ivec2 dg = N8[k], h = ivec2(dg.x, 0), v = ivec2(0, dg.y);
      if (!like(at(p + h), c0) || !like(at(p + v), c0) || like(at(p + dg), c0) || like(at(p - h), c0) || like(at(p - v), c0)) continue;
      // (the line goes on past both arms, and is darker than what lies on the other side of the corner)
      bool goH = like(at(p + 2 * h), c0) || like(at(p + 2 * h - v), c0), goV = like(at(p + 2 * v), c0) || like(at(p + 2 * v - h), c0);
      vec3 a = at(p - h), b = at(p - v);
      if (goH && goV && dot(a, vec3(0.3, 0.55, 0.15)) > l0 + 0.06 && dot(b, vec3(0.3, 0.55, 0.15)) > l0 + 0.06) { o = vec4(like(a, b) ? a : at(p - h - v), 1.0); return; } } }
  int n = likes(p, c0, q);
  bool speck = n == 0 || (n == 1 && likes(q, c0, q2) == 1);
  if (speck) {
    vec3 nb[8]; for (int i = 0; i < 8; i++) nb[i] = at(p + N8[i]);
    int kb = 0; int ib = 0;
    for (int i = 0; i < 8; i++) { if (like(nb[i], c0)) continue; int k = 0; for (int j = 0; j < 8; j++) if (like(nb[i], nb[j])) k++; if (k > kb) { kb = k; ib = i; } }
    float lum0 = dot(c0, vec3(0.3, 0.55, 0.15)), lum1 = dot(nb[ib], vec3(0.3, 0.55, 0.15));
    if (kb >= 3 && abs(dp(p) - dp(p + N8[ib])) < 0.03 && abs(lum0 - lum1) < u_keep) c0 = nb[ib];
  }
  o = vec4(c0, 1.0);
}`,b=`#version 300 es
precision highp float;
uniform sampler2D u_cur, u_hist, u_dep; uniform vec3 u_pal[${Nt}]; uniform int u_n; uniform float u_have;
uniform mat4 u_iview, u_pvp; uniform vec4 u_cam; uniform vec2 u_rng;
out vec4 o;
int idxOf(vec3 c) { for (int i = 0; i < u_pal.length(); i++) { if (i >= u_n) break; vec3 d = abs(c - u_pal[i]); if (max(d.r, max(d.g, d.b)) < 0.5 / 255.0 + 0.00001) return i; } return -1; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), sz = textureSize(u_cur, 0); vec3 c = texelFetch(u_cur, p, 0).rgb; int ci = idxOf(c);
  o = vec4(c, float(ci + 1) / 255.0);
  if (u_have < 0.5 || ci < 0) return;
  float dn = texelFetch(u_dep, p, 0).r; ivec2 q = p;
  if (dn < 0.995) { float z = -(u_rng.x + dn * (u_rng.y - u_rng.x)); vec2 ndc = (vec2(p) + 0.5) / vec2(sz) * 2.0 - 1.0;
    vec3 v = u_cam.z > 0.5 ? vec3(ndc.x * u_cam.x * u_cam.y, ndc.y * u_cam.x, z) : vec3(ndc.x * u_cam.x * u_cam.y * -z, ndc.y * u_cam.x * -z, z);
    vec4 pc = u_pvp * (u_iview * vec4(v, 1.0)); q = ivec2(floor((pc.xy / pc.w * 0.5 + 0.5) * vec2(sz))); }
  if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) return;
  vec4 h = texelFetch(u_hist, q, 0); int prev = int(h.a * 255.0 + 0.5) - 1;
  if (prev >= 0 && ci != prev) o.rgb = h.rgb; }`,z=`#version 300 es
precision highp float;
uniform sampler2D u_src; out vec4 o;
void main() { o = vec4(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`,v=`#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_anc, u_dat, u_sprTex; uniform mat4 u_view, u_proj; uniform vec2 u_vp, u_rng; uniform float u_time, u_keep, u_ortho; uniform vec4 u_rmpN4[16];
flat out ivec2 v_a; flat out ivec4 v_i; flat out float v_dA, v_axial; flat out vec3 v_P, v_N;
${p?"flat out int v_relightOwner;":""}
vec4 sprT(int x, int y) { return texelFetch(u_sprTex, ivec2(x, y), 0); }
int rlen(int r) { return int(u_rmpN4[r >> 2][r & 3] + 0.5) & 15; }
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  int i = gl_InstanceID; ivec2 b = ivec2((i & 255) * 3, i >> 8);
  vec4 t0 = texelFetch(u_anc, b, 0), t1 = texelFetch(u_anc, b + ivec2(1, 0), 0), t2 = texelFetch(u_anc, b + ivec2(2, 0), 0);
  int k = int(t2.x + 0.5); vec4 E0 = sprT(0, k), E1 = sprT(1, k);
  if (t1.w >= u_keep * E1.w) return;
  int j = int(t0.w + 0.5); vec4 m2 = texelFetch(u_dat, ivec2(((j & 511) << 2) + 2, j >> 9), 0), m3 = texelFetch(u_dat, ivec2(((j & 511) << 2) + 3, j >> 9), 0);
  if ((int(m2.w) & 32768) != 0) return;
  ${p?"v_relightOwner = j;":""}
  vec3 pos = t0.xyz;
  if (int(m2.w + 0.5) % 16 == 11) { pos.x += m3.z * sin(u_time * m3.y + pos.y * 1.3 + pos.z * 0.9 + m3.x); pos.y += m3.z * 0.6 * sin(u_time * m3.y * 1.3 + pos.x * 1.1 + m3.x); }
  vec4 cam = u_view * vec4(pos, 1.0); if (cam.z > -0.05) return;
  vec4 clip = u_proj * cam; ivec2 a = ivec2(floor((clip.xy / clip.w * 0.5 + 0.5) * u_vp));
  vec3 N = t1.xyz, vn = mat3(u_view) * N, c = cam.xyz;
  float facing = u_ortho > 0.5 ? -vn.z : dot(vn, c) / length(c); if (abs(facing) > 0.95) return;
  vec2 dir = u_ortho > 0.5 ? vn.xy : vec2(-vn.x * c.z + c.x * vn.z, -vn.y * c.z + c.y * vn.z); float dl = length(dir); if (dl < 1e-12) return; dir /= dl;
  int cat = dir.y > 0.38 ? 0 : dir.y < -0.38 ? 3 : dir.x > 0.0 ? 1 : 2;
  float first = cat == 0 ? E0.x : cat == 3 ? E1.x : E0.z, cnt = cat == 0 ? E0.y : cat == 3 ? E1.y : E0.w; if (cnt < 0.5) return;
  int s = int(first + 0.5) + min(int(cnt + 0.5) - 1, int(floor(t2.w * cnt))), r = int(t2.y + 0.5), band = clamp(int(floor(t2.z * float(rlen(r)))), 0, rlen(r) - 1);
  float dA = clamp((-cam.z - u_rng.x) / (u_rng.y - u_rng.x), 0.0, 1.0);
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  gl_Position = vec4((vec2(a) + 0.5 + corner * 8.0) / u_vp * 2.0 - 1.0, dA * 2.0 - 1.0, 1.0);
  v_a = a; v_i = ivec4(s, cat, r, band); v_dA = dA; v_axial = -cam.z; v_P = pos; v_N = N; }`,A=`#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_sprTex, u_depth, u_idxTex, u_pixTex, u_dat; uniform mat4 u_pview; uniform vec3 u_peye; uniform float u_tanF, u_asp, u_portho, u_eGap, u_tol;
uniform mat4 u_proj; uniform vec2 u_vp; uniform float u_ortho; uniform vec4 u_splatPlane, u_spriteCover;
flat in ivec2 v_a; flat in ivec4 v_i; flat in float v_dA, v_axial; flat in vec3 v_P, v_N;
${p?qn+"flat in int v_relightOwner;":""}
layout(location=0) out vec4 o;
layout(location=1) out vec4 cover;
${xl}
${w??""}
${t?kr(o,s,i):""}
${u?Kt(m):""}
${t||u||p?`
uniform vec3 u_waterSpritePalette[${Nt}];
uniform vec4 u_rmp4[128], u_rmpN4[16];
int spriteColor(int v) {
  if (v >= 100) return clamp(v - 100, 0, u_waterSpritePalette.length() - 1);
  int index = v_i.z;
  int count = int(u_rmpN4[index >> 2][index & 3] + 0.5) & 15;
  int offset = index * 8 + clamp(v_i.w + v - 8, 0, max(0, count - 1));
  return clamp(int(u_rmp4[offset >> 2][offset & 3] + 0.5), 0, u_waterSpritePalette.length() - 1);
}
`:""}
const ivec2 EOD[4] = ivec2[4](ivec2(0, 1), ivec2(1, 0), ivec2(-1, 0), ivec2(0, -1)), ETD[4] = ivec2[4](ivec2(1, 0), ivec2(0, -1), ivec2(0, 1), ivec2(1, 0));
vec4 sprT(int x, int y) { return texelFetch(u_sprTex, ivec2(x, y), 0); }
int dabAt(ivec2 q) { ivec2 s = textureSize(u_idxTex, 0); if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) return -1;
  vec4 e = texelFetch(u_idxTex, q, 0) * 255.0; return int(e.r + 0.5) + int(e.g + 0.5) * 256 + int(e.b + 0.5) * 65536 - 1; }
vec4 pixA(int i) { return texelFetch(u_pixTex, ivec2((i & 1023) * 2, i >> 10), 0); }
vec4 pixB(int i) { return texelFetch(u_pixTex, ivec2((i & 1023) * 2 + 1, i >> 10), 0); }
vec3 hitAt(ivec2 q, int i, vec3 n) { ivec2 sz = textureSize(u_idxTex, 0);
  vec3 v = vec3(((float(q.x) + 0.5) / float(sz.x) * 2.0 - 1.0) * u_tanF * u_asp, ((float(q.y) + 0.5) / float(sz.y) * 2.0 - 1.0) * u_tanF, -1.0);
  vec3 o0 = u_portho > 0.5 ? u_peye + transpose(mat3(u_pview)) * vec3(v.xy, 0.0) : u_peye;
  vec3 d = transpose(mat3(u_pview)) * (u_portho > 0.5 ? vec3(0.0, 0.0, -1.0) : v); vec3 c = texelFetch(u_dat, ivec2((i & 511) << 2, i >> 9), 0).xyz;
  float den = dot(n, d), s = abs(den) > 1e-6 ? dot(n, c - o0) / den : 0.0; return s > 0.0 ? o0 + d * s : c; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), d = p - v_a, od = EOD[v_i.y], td = ETD[v_i.y]; int s = v_i.x;
  vec4 I = sprT(0, 32 + s); int w = int(I.x + 0.5), h = int(I.y + 0.5), sk = int(I.w + 0.5), rr = d.x * od.x + d.y * od.y - 1 + sk, cc = d.x * td.x + d.y * td.y + int(I.z + 0.5);
  if (rr < 0 || rr >= h || cc < 0 || cc >= w) discard;
  int k = rr * w + cc; vec4 t = sprT(1 + (k >> 2), 32 + s); int v = int(t[k & 3] + 0.5); if (v == 0) discard;
  ${w?`
  vec3 inView = axialPosition(gl_FragCoord.xy, v_axial, u_vp);
  if (sectionMargin(transpose(mat3(u_pview)) * (inView - u_pview[3].xyz), v_axial) < 0.0) discard;
  `:""}
  cover = vec4(0.0);
  if (any(notEqual(u_splatPlane.xyz, vec3(0.0))) || any(notEqual(u_spriteCover.xyz, vec3(0.0)))) {
    vec4 at = vec4(axialPosition(gl_FragCoord.xy, v_axial, u_vp), 1.0);
    if (dot(u_splatPlane, at) < 0.0) discard;
    if (any(notEqual(u_spriteCover.xyz, vec3(0.0))) && dot(u_spriteCover, at) >= 0.0) cover = vec4(1.0);
  }
  float dp = texelFetch(u_depth, p, 0).r;
  if (dp < 0.995) {
    if (dp < v_dA - 0.008) discard;   // (something nearer stands here)
    if (rr >= sk) { int j = dabAt(p); bool other;   // (the root rows lie over the thing itself; the rest only past its own surface)
      if (j < 0 || pixA(j).x < 0.5) other = dp - v_dA > u_eGap;
      else { vec4 A = pixA(j), B = pixB(j); other = abs(dot(hitAt(p, j, vec3(A.w, B.x, B.y)) - v_P, v_N)) > u_tol; }
      if (!other) discard; } }
  ${t||u||p?`
  vec3 color = u_waterSpritePalette[spriteColor(v)];
  ${p?"vec4 gain = relightAt(v_relightOwner); if (gain.w > 0.0) color = min(vec3(1.0), color * gain.rgb);":""}
  ${t?"vec3 mark; color = waterPaint(color,gl_FragCoord.xy,u_vp,v_axial,mark);":""}
  ${u?"color = envMedia(color,gl_FragCoord.xy,u_vp,v_axial);":""}
  o = vec4(color,1.0);`:"o = vec4(float(v), float(v_i.z), float(v_i.w), 255.0) / 255.0;"} }`,I=q.replace("out vec4 o;","out ivec4 o;").replace(/void main\(\)\{[\s\S]*$/,"void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec3 k = keyCalc(p); o = ivec4(k, k.x == -99999 ? 0 : 1); }");return{POST_VS:V,POST_FS:q,KEY_FS:I,CLEAN_FS:g,DAMP_FS:b,COPY_FS:z,SPR_VS:v,SPR_FS:A}}function Up(e){return e.replace("if (u_lampN > 0 &&","if (false &&").replace("if (u_fineOn > 0.5 && plain","if (false && plain").replace("if (i >= u_azn) break;","break;")}function bl(e,{ascii:t,specialize:o=!0,sampleCoverage:s,coverageRules:i,stableDetail:r,cutaway:c,airflow:l,footprintGLSL:d,screenPrintGLSL:n,spriteReconstructionGLSL:u}={}){let m=ur(e);try{let z=function(){if(x)throw new Error("The Ink Studio splat pipeline has been disposed")},{vertex:p,fragment:_}=Xn(t,s,{coverageRules:i,stableDetail:r,airflow:l}),w=m.program(p,_),y=new Map,F,T=!1,f,x=!1,E=0,R=0,C=!1,V=m.allocate("VertexArray");e.bindVertexArray(V);let q=m.allocate("Buffer");e.bindBuffer(e.ARRAY_BUFFER,q);let g=new Float32Array([-1,-1,1,-1,-1,1,1,1]);e.bufferData(e.ARRAY_BUFFER,g,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0);let b=m.allocate("Buffer");return e.bindBuffer(e.ARRAY_BUFFER,b),e.enableVertexAttribArray(1),e.vertexAttribIPointer(1,1,e.INT,0,0),e.vertexAttribDivisor(1,1),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),{programFor(v){if(z(),v?.water||v?.portal||v?.instances||v?.contributions||v?.marks||v?.engraving||v?.footprints||v?.masked||v?.layeredGlass||v?.materialStyles||v?.environment||v?.relighting||v?.optical||v?.cutaway||v?.spriteReconstruction||v?.facingColors||v?.splatPaint||v?.depthMeshProxy||v?.gaussianProxy||v?.coverageVote||v?.coverageFilter||v?.gaussianMaterials||v?.surfaceOrder||v?.gaussianDegree!==void 0){let A=!!v.footprints,I=!!v.engraving,ae=!!v.water,W=!!v.portal,Z=!!v.airPockets,S=!!v.layered,k=!!v.atlas,M=!!v.instances,K=!!v.contributions,P=!!v.masked,L=!!v.textured,N=!!v.layeredGlass,H=!!v.materialStyles,pe=!!v.environment,de=!!v.emitterFog,ye=!!v.relighting,Y=!!v.optical,D=+Z+2*S+4*k+8*ae+16*W+32*M+64*K+128*P+256*L+512*N+1024*H+2048*pe+4096*ye+8192*Y+16384*!!v.cutaway+32768*de+65536*A+131072*I+262144*!!v.spriteReconstruction+524288*!!v.facingColors+1048576*((v.gaussianDegree??-1)+1)+8388608*!!v.splatPaint+16777216*!!v.gaussianProxy+33554432*!!v.coverageVote+67108864*!!v.gaussianMaterials+134217728*!!v.surfaceOrder+268435456*!!v.depthMeshProxy+536870912*!!v.marks+1073741824*!!v.coverageFilter;if(!y.has(D)){let _e=Xn(t,s,{water:ae,airPockets:Z,layered:S,atlas:k,portal:W,instances:M,contributions:K,masked:P,textured:L,layeredGlass:N,coverageRules:i,materialStyles:H,environment:pe,emitterFog:de,relighting:ye,optical:Y,stableDetail:r,airflow:l,footprints:A,footprintGLSL:d,screenPrintGLSL:n,engraving:I,marks:v.marks,facingColors:v.facingColors,gaussianDegree:v.gaussianDegree,splatPaint:v.splatPaint,gaussianProxy:v.gaussianProxy,depthMeshProxy:v.depthMeshProxy,gaussianMaterials:v.gaussianMaterials,surfaceOrder:v.surfaceOrder,coverageVote:v.coverageVote,coverageFilter:v.coverageFilter,spriteReconstruction:v.spriteReconstruction?u:void 0,cutaway:v.cutaway?c:void 0});y.set(D,m.program(_e.vertex,_e.fragment))}return y.get(D)}if(!o||T||v?.lamps!==!1||v.fine!==!1||v.textZones!==!1)return w;if(!F)try{F=m.program(Up(p),_)}catch(A){if(e.isContextLost())throw A;return T=!0,w}return F},setOrder(v,A=!1){if(z(),!(v instanceof Int32Array)||A&&v.length%2)throw new TypeError("Draw order must be an Int32Array with the selected stride");e.bindBuffer(e.ARRAY_BUFFER,b),v.byteLength>E?(e.bufferData(e.ARRAY_BUFFER,v,e.DYNAMIC_DRAW),E=v.byteLength):v.length&&e.bufferSubData(e.ARRAY_BUFFER,0,v),A!==C&&(e.bindVertexArray(V),e.vertexAttribIPointer(1,1,e.INT,A?8:0,0),A?(e.enableVertexAttribArray(2),e.vertexAttribIPointer(2,1,e.INT,8,4),e.vertexAttribDivisor(2,1)):e.disableVertexAttribArray(2),e.bindVertexArray(null),C=A),R=v.length/(A?2:1)},draw(v=R,A=V){if(z(),!Number.isInteger(v)||v<0||A===V&&v>R)throw new RangeError("Invalid splat draw count");v&&(e.bindVertexArray(A),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,v))},get count(){return R},drawSubset(v){if(z(),!(v instanceof Int32Array))throw new TypeError("Subset order must be an Int32Array");v.length&&(f||(f={vao:m.allocate("VertexArray"),buffer:m.allocate("Buffer")},e.bindVertexArray(f.vao),e.bindBuffer(e.ARRAY_BUFFER,q),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.bindBuffer(e.ARRAY_BUFFER,f.buffer),e.enableVertexAttribArray(1),e.vertexAttribIPointer(1,1,e.INT,0,0),e.vertexAttribDivisor(1,1)),f.indices!==v&&(e.bindBuffer(e.ARRAY_BUFFER,f.buffer),e.bufferData(e.ARRAY_BUFFER,v,e.DYNAMIC_DRAW),f.indices=v),e.bindVertexArray(f.vao),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,v.length))},dispose(){x||(x=!0,m.dispose())}}}catch(p){throw m.dispose(),p}}var Wn=17,Eo=18,Fo=19,zo=20,kl=new Map([["fog",0],["box",1],["sphere",2],["shaft",3]]),ba=[0,0,0],Gp=e=>Math.round(255*Math.max(0,Math.min(1,e))),$p=e=>[e>>16&255,e>>8&255,e&255].map(t=>t/255);function jp(e,t,o){let s=kl.get(e.type),i=e.min??e.at??e.from??[0,e.bottom??-1e20,0],r=e.max??e.axis??[0,e.top??1e20,0];t.set([...i,s,...r,e.height??0,...e.rgb,e.density,e.near,e.far??1e20,e.radius??0,+!!e.lit],o)}function qp(e,t,o){let s=[...e.map(c=>c.paletteField),t?.paletteField];if(!s.some(c=>c?.strength))return{rows:[],fog:!1,card:-1};let i=new Float32Array(s.length*8),r=[];return s.forEach((c,l)=>{if(!c?.strength)return;let d=o+s.length*2+r.length/4;if(c.stops)for(let{at:u,rgb:m}of c.stops)r.push(...m,u);else for(let u=0;u<=128;u++)r.push(...c.sampleUnit(u/128),0);let n=["depth","altitude","density","light"].indexOf(c.source);i.set([c.stops?1:2,n,c.low,c.span,d,c.stops?.length??129,c.strength,e[l]?.step??0],l*8)}),{rows:[...i,...r],fog:e.some(c=>c.paletteField),card:t?.paletteField?.strength?o+2*e.length:-1}}function Tl(e,t,{table:o,textureUnit:s},i,r){let c=r.KIT,l=r.EnvironmentFrame??c?.environmentFrame,d=r.SkyEnvironment??c?.skyEnvironment,n=r.CelestialTracks??c?.celestialTracks,u=r.ArtDirection??c?.artDirection,m=r.HorizonBands??c?.horizonBands,p,_,w,y,F,T,f=new WeakMap;function x(R){return e.activeTexture(e.TEXTURE0+R),t.texture()}function E(R,C,V,q,g,b,z,v){if(C.environment===!1||!l||!d)return null;let A=C.skyEnvironment??R.skyEnvironment,I=C.cloudField??R.cloudField,ae=C.atmosphere===!1?[]:R.atmosphere??[],W=C.horizonBands??R.look?.horizonBands,Z=C.celestialTracks??R.celestialTracks;if(!A&&!I&&!ae.length&&!W&&!Z)return null;let S=u?.prepare(R.look?.artDirection,C.artDirection),k=l.timeline(R,C,q,S,c?.weather?.tracks),M=$p(R.pal[0]),K=n?.settings(R.celestialTracks,C.celestialTracks)?.frame(k.skyTime),P=d.withCelestials(k.environment?.sky,K,M),L=z?d.forReflection(P):P,N=Cr(V),H=N.eye.map((le,Re)=>le-V.setback*N.back[Re]),pe,de,ye=l.opticalWeather(R,C,k);if(I&&c?.clouds){let le;typeof I=="string"?le=c.clouds.compile(I):(le=f.get(I),le||(le=c.clouds.compile(I),f.set(I,le)));let{windConfig:Re,flow:Pe}=l.wind(R,C,{...k,weather:ye}),Ce=Re&&Re.clouds!==!1?Pe.cloudTravel(0,k.skyTime).map(Ee=>Ee*Re.clouds):void 0;pe=le.frame(k.skyTime,null,K?.sun?.direction??L?.sun,Ce,C.cloudRepresentation??R.cloudRepresentation,void 0,void 0,S?.cloudEdge),de=pe.view?.(H,V.ortho?N.back:null)}let Y=de?.card,D=c?.atmosphere?.prepare(ae.filter(le=>kl.has(le?.type)),R.pal,void 0,ye?.fogGain,k.skyTime)??[];if(D.length>16)throw new RangeError("WebGL supports up to "+16+" analytic atmosphere volumes per frame");let _e=Math.atan2(N.back[0],N.back[2]),Se=Math.atan2(N.back[1],Math.hypot(N.back[0],N.back[2])),Ae=m?.prepare(R.look?.horizonBands,C.horizonBands)?.frame({eye:H,yaw:_e,pitch:Se,distance:V.distance-V.setback,parameters:k.environment?.parameters}),B=pe?.visible&&!de;if(!L&&!Y&&!D.length&&!Ae&&!B)return null;let ie=V.ortho?Math.tan((L?.orthoFov??Math.PI/3)*.5):V.tangent,se=[ie*V.aspect,ie],ve=Math.max(V.distance+2*V.radius,Y?de.horizon(N.eye):0),j=!!(L?.celestial||L?.paletteRamp||L?.paletteField||Ae||B),X=j?[]:L?.splats??[],G=4*(D.length+X.length),Q=qp(D,Y,G),be=new Float32Array(G*4+Q.rows.length);be.set(Q.rows,G*4);for(let le=0;le<D.length;le++)jp(D[le],be,le*16);for(let le=0;le<X.length;le++){let Re=X[le];be.set([...Re.direction,Re.opacity,...Re.right,Re.size[0],...Re.up,Re.size[1],...Re.color,0],16*(le+D.length))}if(p||(e.activeTexture(e.TEXTURE0+Wn),p=o(64,Wn,i)),p.upload(be),j){T??=x(zo);let le=new Uint8Array(g*b*4),Re=[0,0,0],Pe=[0,0,0],Ce=L&&S?.bands?{...L,bands:S.bands}:L;for(let Ee=0;Ee<b;Ee++)for(let ke=0;ke<g;ke++){let he=(2*(ke+.5)/g-1)*se[0],te=(2*(Ee+.5)/b-1)*se[1],ze=1/Math.hypot(he,te,1);for(let fe=0;fe<3;fe++)Pe[fe]=M[fe],Re[fe]=(N.right[fe]*he+N.up[fe]*te-N.back[fe])*ze;Ce&&d.shade(Ce,Re,Pe),Ae?.(Re,Pe),B&&pe.paint(H,Re,Pe);let me=4*(Ee*g+ke);for(let fe=0;fe<3;fe++)le[me+fe]=Gp(Pe[fe]);le[me+3]=255}s(zo,T),e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,g,b,0,e.RGBA,e.UNSIGNED_BYTE,le)}else p.bind(zo);Y?(_??=x(Eo),s(Eo,_),w!==Y.pixels&&(e.texImage2D(e.TEXTURE_2D,0,e.RGB32F,Y.resolution,Y.resolution,0,e.RGB,e.FLOAT,Y.pixels),w=Y.pixels)):p.bind(Eo);let ge=Y?.lighting;return ge?(y??=x(Fo),s(Fo,y),F!==ge.cells&&(e.texImage2D(e.TEXTURE_2D,0,e.R32F,ge.width,ge.rows,0,e.RED,e.FLOAT,ge.cells),F=ge.cells)):p.bind(Fo),{media:!!(Y||D.length),lit:D.some(le=>le.lit),uniforms:{u_envData:Wn,u_envCard:Eo,u_envCloudLight:Fo,u_envBackdrop:zo,u_envEye:N.eye,u_envRight:N.right,u_envUp:N.up,u_envBack:N.back,u_envCamera:[V.tangent*V.aspect,V.tangent,+V.ortho,V.setback],u_envSkyView:se,u_envHorizon:ve,u_envBackground:M,u_envHasSky:+!!L,u_envSkySplats:X.length,u_envSkyStart:D.length*4,u_envBackdropSampled:+j,u_envZenith:L?.zenith??ba,u_envSkyHorizon:L?.horizon??ba,u_envGround:L?.ground??ba,u_envSun:L?.sun??ba,u_envSunRGB:L?.sunColor??ba,u_envSunParams:[L?.sunEdge??0,L?.sunCore??1,L?.sunStrength??0],u_envEntryPlane:v,u_envFogCount:D.length,u_envBands:S?.atmosphereBands??0,u_envPaletteFog:+Q.fog,u_envPaletteStart:G,u_envPaletteCard:Q.card,u_envCardSize:Y?.resolution??0,u_envCloudHardness:S?.cloudHardness??.5,...Y&&{u_envCardFrame:[...Y.center,Y.radius],u_envCardRight:Y.right,u_envCardUp:Y.up,u_envCardNormal:Y.normal,u_envCloudRGB:Y.rgb,u_envCloudHeight:[ge?.low??0,ge?.thickness??1,Y.opacity,ge?.probe??0]},...ge&&{u_envCloudStyle:[ge.ambient,ge.strength,ge.rim,ge.daylight],u_envCloudDomain:[...ge.origin,...ge.cell],u_envCloudSun:ge.direction,u_envCloudLightRGB:ge.rgb}}}}return{prepare:E}}var Rl=(e,t)=>`#version 300 es
precision highp float;
uniform sampler2D u_source, u_destination, u_cover, u_spriteCover, u_foreground;
uniform sampler2D u_aperture;
uniform vec3 u_origin, u_right, u_up, u_normal, u_eye;
uniform vec4 u_entryPlane;
uniform mat4 u_portalView;
uniform vec3 u_settings;
uniform vec2 u_half, u_size;
uniform int u_opening, u_hasSpriteCover, u_painted;
uniform float u_fade, u_far;
out vec4 o;
${e?Kt(t):""}
bool throughOpening(out float axialDepth) {
  vec2 p = (gl_FragCoord.xy / u_size * 2.0 - 1.0) * u_settings.xy;
  bool ortho = u_settings.z > 0.5;
  mat3 world = transpose(mat3(u_portalView));
  vec3 eye = u_eye + (ortho ? world * vec3(p, 0.0) : vec3(0));
  vec3 ray = world * vec3(ortho ? vec2(0) : p, -1.0);
  float towards = dot(ray, u_normal);
  if (towards >= -1e-7) return false;
  float t = dot(u_origin - eye, u_normal) / towards;
  if (t <= 0.0 || t >= u_far) return false;
  axialDepth = t;
  vec3 at = eye + ray * t;
  if (dot(u_entryPlane, vec4(at, 1.0)) < 0.0) return false;
  vec3 relative = at - u_origin;
  vec2 local = vec2(dot(relative, u_right), dot(relative, u_up)) / u_half;
  if (u_opening == 2 ? dot(local, local) > 1.0 : any(greaterThan(abs(local), vec2(1.0)))) return false;
  if (u_painted != 0) {
    ivec2 size = textureSize(u_aperture, 0);
    vec2 uv = vec2(local.x, -local.y) * 0.5 + 0.5;
    ivec2 cell = clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1);
    if (texelFetch(u_aperture, cell, 0).r < 0.5) return false;
  }
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  return texelFetch(u_cover, pixel, 0).r < 0.5 &&
    (u_hasSpriteCover == 0 || texelFetch(u_spriteCover, pixel, 0).r < 0.5);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 color = texelFetch(u_source, p, 0).rgb;
  float axialDepth;
  if (u_opening != 0 && throughOpening(axialDepth)) {
    vec4 foreground = texelFetch(u_foreground, p, 0);
    vec3 destination = texelFetch(u_destination, p, 0).rgb;
    ${e?"destination = envMedia(destination, gl_FragCoord.xy, u_size, axialDepth);":""}
    color = foreground.rgb + destination * (1.0 - foreground.a);
  }
  o = vec4(color * (1.0 - u_fade), 1.0);
}`;var Vp=new WeakMap;var Al=16777215;function Xp(e){if(!e.some(l=>l.splatFootprints))return;let t=[],o=new Map,s=e.reduce((l,d)=>l+d.count,0),i=new Uint16Array(s),r=e.some(l=>l.splatFootprints?.frames)?new Float32Array(s*6):void 0,c=0;for(let l of e){let d=l.splatFootprints;if(d){let n=d.styles.map(u=>{let m=JSON.stringify(u);if(!o.has(m)){if(t.length>=64)throw new RangeError("Instances exceed 64 footprint styles");o.set(m,t.push(u))}return o.get(m)});for(let u=0;u<l.count;u++){let m=d.indices[u]??0;i[c+u]=m?n[m-1]:0}d.frames&&r.set(d.frames,c*6)}c+=l.count}return Object.freeze({version:1,styles:Object.freeze(t),indices:i,...r&&{frames:r}})}function Pr(e){let t=Vp.get(e);if(!t)throw new TypeError("Expected instances from createSplatInstances");return t}function Sl(e,t,o){let{asset:s,matrix:i,at:r,authored:c,swatches:l,mask:d,diagonal:n}=t,{opacity:u,visible:m}=c,p=new Map(l);for(let _=0,w=o*16;_<s.count*16;_+=16,w+=16){let y=s.data,F=y[_],T=y[_+1],f=y[_+2],x=F-d?.[0],E=T-d?.[1],R=f-d?.[2];e[w]=i[0]*F+i[1]*T+i[2]*f+r[0],e[w+1]=i[3]*F+i[4]*T+i[5]*f+r[1],e[w+2]=i[6]*F+i[7]*T+i[8]*f+r[2],e[w+3]=!m||T<-30||d&&x*x+E*E+R*R<=d[3]?0:y[_+3]*u;let C=y[_+4],V=y[_+5],q=y[_+6],g=y[_+8],b=y[_+9],z=y[_+10];if(n){let v=i[0]*i[0];e[w+4]=C*v,e[w+5]=V*v,e[w+6]=q*v,e[w+8]=g*v,e[w+9]=b*v,e[w+10]=z*v}else for(let v=0;v<3;v++){let A=v*3,I=i[A]*C+i[A+1]*V+i[A+2]*q,ae=i[A]*V+i[A+1]*g+i[A+2]*b,W=i[A]*q+i[A+1]*b+i[A+2]*z;for(let Z=v;Z<3;Z++){let S=v===0?4+Z:v===1?7+Z:10,k=Z*3;e[w+S]=I*i[k]+ae*i[k+1]+W*i[k+2]}}e[w+7]=p.get(y[_+7])??y[_+7],e[w+11]=y[_+11]}}function El(e,t,o){let s=t.asset.materialPixelStyles;if(!e||!s||(o*=4,e.set(s,o),!t.swatches.length))return;let i=new Map(t.swatches);for(let r=o+2;r<o+s.length;r+=4)e[r]=i.get(e[r])??e[r],e[r+1]=i.get(e[r+1])??e[r+1]}function Fl(e,{asset:t,authored:{rotation:o}},s){if(!(!e||!t.normals))for(let i=0,r=s*3;i+2<t.normals.length;i+=3,r+=3){let c=t.normals[i],l=t.normals[i+1],d=t.normals[i+2];for(let n=0;n<3;n++){let u=n*3;e[r+n]=o[u]*c+o[u+1]*l+o[u+2]*d}}}function zl(e,t){return Xp([e,...t.rows.map(({asset:o,matrix:s})=>{let i=o.splatFootprints;if(!i?.frames)return o;let r=i.frames.slice();for(let c=0;c<r.length;c+=3){let l=r[c],d=r[c+1],n=r[c+2];for(let u=0;u<3;u++)r[c+u]=s[u*3]*l+s[u*3+1]*d+s[u*3+2]*n}return{...o,splatFootprints:{...i,frames:r}}})])}function Ml(e,t){if(e+t.count>Al||e+t.sharedCount>Al)throw new RangeError("Instances exceed the 24-bit splat address space")}var ii=512,Pl=256,Hn=64,Wp=Pl*4/Hn;function Hp(e,t,o,s,i,r,c){let{authored:l,asset:d,center:n,extent:u,spread:m}=e;if(!l.visible||!l.opacity||d.empty)return!1;let[p,_,w]=n,y=t.view,F=.001+1e-6*(Math.abs(p)+Math.abs(_)+Math.abs(w)),T=-(y[2]*p+y[6]*_+y[10]*w+y[14]),f=u+F;if(T+f<t.clipNear)return!1;let x=Math.abs(y[0]*p+y[4]*_+y[8]*w+y[12]),E=Math.abs(y[1]*p+y[5]*_+y[9]*w+y[13]),R=m*Math.abs(c);return t.ortho?x<=o+i+f+R&&E<=s+r+f+R:x<=(o+i)*(T+f)+f+R*Math.hypot(1,1.3*o)&&E<=(s+r)*(T+f)+f+R*Math.hypot(1,1.3*s)}function Cl(e,{index:t,start:o,asset:s,matrix:i,at:r,authored:c,swatches:l,diagonal:d,mask:n}){let u=(t+1)*Hn;for(let m=0;m<3;m++){let p=m*3;e.set([i[p],i[p+1],i[p+2],r[m]],u+m*4)}e.set([s.offset-o,l.length,c.opacity,+d+2*!!n],u+12),d&&e.set([r[0],r[1],r[2],i[0]],u+52),n&&e.set(n,u+16);for(let m=0;m<l.length;m++)e.set(l[m],u+20+m*2)}function Dl(e,t,o,s,i){let r=t.tangent*t.aspect,c=t.tangent,l=6*r/o,d=6*c/s;return e.rows.filter(n=>Hp(n,t,r,c,l,d,i))}function Il(e,t){return t??Array.from({length:Math.ceil(e.count/ii)},(o,s)=>s)}function Gi(){let e,t,o,s,i,r,c,l,d,n,u,m,p,_;return function(y,F,T){let f=Pr(F);if(y!==e||F!==t||y.data!==i||y.count!==r||y.fine!==c||y.pix!==l||y.renderMetadata!==d||y.materialPixelStyles!==n||y.opticalSplats!==u||y.splatFootprints!==m||y.engraving!==p){o=F.flatten(y);let{data:R,count:C,fine:V,pix:q,renderMetadata:g,materialPixelStyles:b,opticalSplats:z,splatFootprints:v,engraving:A}=o;return _={data:R,count:C,fine:V,pix:q,renderMetadata:g,materialPixelStyles:b,opticalSplats:z,splatFootprints:v,engraving:A},e=y,t=F,i=y.data,r=y.count,c=y.fine,l=y.pix,d=y.renderMetadata,n=y.materialPixelStyles,u=y.opticalSplats,m=y.splatFootprints,p=y.engraving,s=f.revision,{world:o}}Object.assign(o,y,_);let x=Il(y,T),E=new Set(x);for(let R of x){let C=R*ii*16,V=Math.min(C+ii*16,y.count*16);o.data.set(y.data.subarray(C,V),C),u&&o.opticalSplats.set(u.subarray(C/16*12,V/16*12),C/16*12);let q=y.renderMetadata?.normals;q&&o.renderMetadata.normals.set(q.subarray(C/16*3,V/16*3),C/16*3)}if(s!==f.revision){f.rows.some(R=>R.asset.splatFootprints?.frames)&&(_.splatFootprints=o.splatFootprints=zl(y,f));for(let R of f.rows){if(!(R.version>s))continue;let C=y.count+R.start;Sl(o.data,R,C),El(o.materialPixelStyles,R,C),Fl(o.renderMetadata.normals,R,C);let V=Math.ceil((C+R.asset.count)/ii);for(let q=Math.floor(C/ii);q<V;q++)E.add(q)}s=f.revision}return{world:o,changedRows:[...E]}}}function Ll(e,t,o){let s=e(Pl,15,o),i,r,c,l,d,n,u;return{bind(m,p,_,w,y=p.data){let F=Pr(m),T=i!==m||d!==p||n!==p.data||u!==p.count;if(T){let x=(p.count+F.sharedCount)*16;if(Math.ceil(x/(ii*16))>o)throw new RangeError("Shared splat geometry exceeds the WebGL texture size limit");r=new Float32Array(x),r.set(y.subarray(0,p.count*16));for(let E of F.assets)r.set(E.data,(p.count+E.offset)*16)}let f=Il(p,_);if(!T)for(let x of f){let E=x*ii*16;r.set(y.subarray(E,Math.min(E+ii*16,p.count*16)),E)}if(t.upload(r,r.length,T||w?void 0:f),i!==m){c=new Float32Array((F.rows.length+1)*Hn);for(let x of F.rows)Cl(c,x);s.upload(c)}else if(l!==F.revision){let x=new Set;for(let E of F.rows)E.version>l&&(Cl(c,E),x.add(Math.floor((E.index+1)/Wp)));s.upload(c,c.length,[...x])}else s.bind();return i=m,d=p,n=p.data,u=p.count,l=F.revision,F}}}var Kp=["red","green","blue","luminance","alpha"],Bl=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2];function Nl(e,t,o){let s=[],i=[],r=0;for(let{maskSource:u}of e){if(!u){s.push(null);continue}let[m,p]=u.range??[0,1],_=[u.type==="axis"?1:2,+(u.space!=="world"),["linear","smooth","step"].indexOf(u.interpolation??"smooth"),+!!u.invert];if(u.type==="axis"){let{direction:v,offset:A}=t.axis(u);s.push([..._,...v,A,m,1/(p-m)]);continue}let{x:w,z:y,origin:F}=t.plane(u.projection),[T,f]=u.scale??[1,1],[x,E]=u.offset??[0,0],{width:R,height:C,frames:V,fps:q=1,channels:g=4,repeat:b=!1,wrap:z=!1}=u.raster;s.push([..._,...w.map(v=>v/T),(-Bl(w,F)-x)/T,m,1/(p-m),r,+z,...y.map(v=>v/f),(-Bl(y,F)-E)/f,R,C,V.length,q,+b]),r+=R*C*V.length,i.push({frames:V,channels:g,channel:Kp.indexOf(u.channel??"alpha")})}if(!r)return{rows:s};let c=Math.min(o,1024),l=Math.ceil(r/c);if(l>o||r>2**22)throw new RangeError("WebGL look mask textures exceed their atlas budget");let d=new Float32Array(c*l),n=0;for(let{frames:u,channels:m,channel:p}of i)for(let _ of u)for(let w=0;w<_.length;w+=m){let y=m===4?_[w+3]/255:1,F=p===4?1:p===3?(.3*_[w]+.55*_[w+1]+.15*_[w+2])/255:_[w+p]/255;d[n++]=F*y}return{rows:s,texture:{width:c,height:l,values:d}}}var Yp=["South","East","West","North","LeftBumper","RightBumper","LeftTrigger","RightTrigger","Back","Start","LeftStick","RightStick","DPadUp","DPadDown","DPadLeft","DPadRight","Home"],Zp=["LeftX","LeftY","RightX","RightY"],Qp=["Left","Middle","Right","Back","Forward"],Jp={0:"Tip",2:"Barrel",5:"Eraser"},ed=[1,4,2,8,16,32],Gl=["Alt","Control","Meta","Shift"],Kn=new WeakSet,Zn=e=>Math.min(1,Math.max(-1,e)),bi=Object.freeze([]),Ol='input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[role="textbox"]';function Yn(e){return Gl.filter(t=>e[t==="Control"?"ctrlKey":t.toLowerCase()+"Key"])}function Ul(e,t){return Gl.filter(o=>e.includes(o)&&t!=="key:"+o+"Left"&&t!=="key:"+o+"Right")}function Mo(e,t){for(let[o,s]of e)Math.abs(s)>Math.abs(t[o])&&(t[o]=s)}function td(e){let t=e.mapping==="standard",o=new Map;return Array.from(e.buttons??[]).slice(0,64).forEach((s,i)=>{let r=Number.isFinite(s?.value)?s.value:s?.pressed?1:0;o.set("pad:"+(t&&Yp[i]||"Button"+i),Math.max(0,Math.min(1,r)))}),Array.from(e.axes??[]).slice(0,32).forEach((s,i)=>{o.set("pad:"+(t&&Zp[i]||"Axis"+i),Number.isFinite(s)?Zn(s):0)}),o}function $l(e,{toolkit:t,contexts:o,context:s,onAction:i,onPointer:r,onFocus:c,focusOnPointer:l=!0,tabStop:d=!0,motionScale:n=96,readGamepads:u}={}){let m=(t?.KIT??t)?.procedural?.inputActions?.compile,p=e?.ownerDocument,_=p?.defaultView;if(typeof m!="function"||!_||typeof e.focus!="function"||Kn.has(e)||[i,r,c,u].some(B=>B!==void 0&&typeof B!="function")||typeof l!="boolean"||typeof d!="boolean"||!Number.isFinite(n)||n<=0)throw new TypeError("Viewer input needs an available DOM surface, action toolkit, and valid options");let w=m(o),y=s??Object.keys(w.profile)[0],F={...w.sample(y,bi)},T=!1,f=!0,x=!1,E=!1,R=new Set,C=new Map,V=new Map,q=new Map,g=new Set,b=new Set,z=[],v=[],A=e.getAttribute("tabindex"),I=d&&A===null&&e.tabIndex<0;I&&e.setAttribute("tabindex","0"),Kn.add(e);function ae(B,ie,se,ve){B.addEventListener(ie,se,ve),z.push(()=>B.removeEventListener(ie,se,ve))}function W(B,ie,se,ve){i?.(Object.freeze({action:B,phase:ie,value:se,...ve}))}function Z(B,ie){let se=F;F=B;for(let[ve,j]of Object.entries(B)){if(F!==B)break;let X=se[ve]??0;if(j===X)continue;let G=j===0?"release":X===0?"press":"change";G==="press"&&g.add(ve),G==="release"&&b.add(ve),W(ve,G,j,ie)}}function S(B){let ie={...w.sample(y,bi)};for(let se of R){let ve=w.resolve(y,se,1,Ul(v,se));ve&&Mo([[ve.action,ve.value]],ie)}for(let{binding:se}of C.values())se&&Mo([[se.action,se.value]],ie);for(let{levels:se}of V.values())Mo(se,ie);Z(ie,B)}function k(B){e.hasPointerCapture?.(B.id)&&e.releasePointerCapture(B.id)}function M(B,ie,se,ve=[0,0]){r?.(Object.freeze({phase:ie,id:B.id,device:B.device,action:B.binding?.action??null,input:B.input,point:Object.freeze(B.point.slice()),delta:Object.freeze(ve),event:se}))}function K(){R.clear(),v=[],V.clear(),q.clear(),g.clear();let B=[...C.values()];C.clear(),Z({...w.sample(y,bi)},{device:"focus"});for(let ie of B)k(ie),M(ie,"cancel")}function P(){let B;try{B=u?u():_.navigator.getGamepads?.()}catch{B=bi}let ie=new Set;for(let[se,ve]of Array.from(B??bi).slice(0,16).entries()){if(!ve||ve.connected===!1)continue;ie.add(se);let j=ve.id+"\0"+ve.mapping,X=V.get(se),G=td(ve),Q=X?.identity===j?X.blocked:new Set([...G].filter(([,ge])=>Math.abs(ge)>.12).map(([ge])=>ge)),be=[];for(let[ge,le]of G){if(Q.has(ge)){Math.abs(le)<=.12&&Q.delete(ge);continue}let Re=w.resolve(y,ge,le);Re&&be.push([Re.action,Re.value])}V.set(se,{identity:j,blocked:Q,levels:be})}for(let se of V.keys())ie.has(se)||V.delete(se);S({device:"gamepad"})}function L(){let B=!x&&f&&!E&&p.visibilityState!=="hidden"&&(p.hasFocus?.()??!0)&&e.getRootNode().activeElement===e&&!e.matches?.(Ol)&&!e.isContentEditable;return B!==T&&(T=B,B?P():K(),c?.(T)),T}function N(B){let ie=B.composedPath?.()[0]??B.target;return ie===e&&!ie.closest?.(Ol)&&!ie.isContentEditable}function H(){return x||!f?!1:(e.focus({preventScroll:!0}),L())}function pe(B,ie){if(!L()||!N(B)||B.defaultPrevented||B.isComposing||!B.code||B.code==="Tab"||!/^\w[\w-]{0,47}$/.test(B.code))return;let se="key:"+B.code;if(ie&&B.repeat&&!R.has(se))return;v=Yn(B);let ve=w.resolve(y,se,1,Ul(v,se)),j=R.has(se);ie?R.add(se):R.delete(se);let X={device:"keyboard",input:se,event:B};S(X),ie&&B.repeat&&ve?.value&&W(ve.action,"repeat",ve.value,X),ve?.value&&(ie||j)&&B.preventDefault()}function de(B){let ie=e.getBoundingClientRect();return[B.clientX-ie.left,B.clientY-ie.top]}function ye(B){if(!f||B.defaultPrevented||!N(B)||C.has(B.pointerId)||C.size>=16||(l&&!L()&&H(),!L()))return;let ie=B.pointerType==="touch"?"touch":B.pointerType==="pen"?"pen":"mouse",se=ie==="touch"?"Contact":ie==="pen"?Jp[B.button]:Qp[B.button],ve=Yn(B),j=se&&ie+":"+se,X=j?w.resolve(y,j,1,ve):null,G=["X","Y"].some(be=>w.resolve(y,ie+":Drag"+be,1,ve)?.value);if(!X?.value&&!G)return;let Q={id:B.pointerId,device:ie,input:j,binding:X,chord:ve,button:B.button,point:de(B)};C.set(Q.id,Q);try{e.setPointerCapture?.(Q.id)}catch{}B.preventDefault(),S({device:ie,input:j,event:B}),C.has(Q.id)&&M(Q,"start",B)}function Y(B,ie,se,ve){if(!Number.isFinite(ie)||!ie||!w.resolve(y,B,1,se)?.value)return!1;let j=B+" "+se.join("+"),X=(q.get(j)?.value??0)+ie;q.set(j,{input:B,value:X,chord:se});let G=w.resolve(y,B,Zn(ie/n),se);return G.value&&W(G.action,"pulse",G.value,{...ve,input:B}),!0}function D(B){if(!L())return;let ie=C.get(B.pointerId);if(!ie)return;if(ie.device!=="touch"&&B.isTrusted&&!(B.buttons&ed[ie.button])){_e(B,"end");return}let se=de(B),ve=[se[0]-ie.point[0],se[1]-ie.point[1]];ie.point=se;let j={device:ie.device,event:B};Y(ie.device+":DragX",ve[0],ie.chord,j),Y(ie.device+":DragY",ve[1],ie.chord,j),C.has(ie.id)&&M(ie,"move",B,ve),B.preventDefault()}function _e(B,ie){let se=C.get(B.pointerId);se&&(C.delete(se.id),ie==="end"&&(se.point=de(B)),k(se),S({device:se.device,input:se.input,event:B}),M(se,ie,B))}function Se(B){if(B.defaultPrevented||!N(B)||!L())return;let ie=B.deltaMode===1?16:B.deltaMode===2?e.clientHeight:1,se=Yn(B),ve={device:"wheel",event:B},j=Y("wheel:X",B.deltaX*ie,se,ve),X=Y("wheel:Y",B.deltaY*ie,se,ve);(j||X)&&B.preventDefault()}function Ae(B,ie=y){if(x)throw new Error("Viewer input is disposed");let se=m(B);return se.sample(ie,bi),K(),w=se,y=ie,F={...w.sample(y,bi)},L()&&P(),w.profile}for(let[B,ie]of Object.entries({focus:L,blur:L,keydown:se=>pe(se,!0),keyup:se=>pe(se,!1),pointerdown:ye,pointermove:D,pointerup:se=>_e(se,"end"),pointercancel:se=>_e(se,"cancel"),lostpointercapture:se=>_e(se,"cancel")}))ae(e,B,ie);return ae(e,"wheel",Se,{passive:!1}),ae(p,"visibilitychange",L),ae(_,"blur",()=>{E=!0,L()}),ae(_,"focus",()=>{E=!1,L()}),ae(_,"gamepaddisconnected",()=>{L()&&P()}),Object.freeze({get focused(){return L()},get context(){return y},profile:()=>w.profile,focus:H,setProfile:Ae,setContext(B){B!==y&&Ae(w.profile,B)},setBindings(B,ie,se){let ve=w.profile;if(!Object.hasOwn(ve,B)||!Object.hasOwn(ve[B],ie))throw new TypeError("Unknown viewer input context or action");return Ae({...ve,[B]:{...ve[B],[ie]:se}})},setEnabled(B){if(typeof B!="boolean")throw new TypeError("Viewer input enabled state must be Boolean");f=B,L()},poll(){L()&&P();let B={...F};for(let{input:se,value:ve,chord:j}of q.values()){let X=w.resolve(y,se,Zn(ve/n),j);X&&Mo([[X.action,X.value]],B)}let ie=Object.freeze({context:y,focused:T,values:Object.freeze(B),pressed:Object.freeze([...g]),released:Object.freeze([...b])});return g.clear(),b.clear(),q.clear(),ie},dispose(){if(!x){x=!0;for(let B of z)B();Kn.delete(e),I&&e.getAttribute("tabindex")==="0"&&e.removeAttribute("tabindex"),T&&(T=!1,K(),c?.(!1))}}})}var Qe=new Float32Array(4),rd=new Float32Array(0),jl=Symbol("reconstruction source"),Qn=Symbol("portal depth"),Co=Symbol("reflection plane"),Hl=2;function Kl(e,t,o,s){let i=e.KIT?.reconstruction;if(!i)throw new Error("World reconstruction needs the Ink Studio KIT");return i.frame(t,o.time??t.lookSnapshot?.time??0,s)}var ai=e=>[(e>>16&255)/255,(e>>8&255)/255,(e&255)/255];function ql(e,t=Nt){let o=new Float32Array(t*3);for(let s=0;s<Math.min(t,e.length);s++)o.set(ai(e[s]),s*3);return o}function id(e,t){let o=new Float32Array(16);for(let s=0;s<4;s++)for(let i=0;i<4;i++){let r=0;for(let c=0;c<4;c++)r+=e[c*4+i]*t[s*4+c];o[s*4+i]=r}return o}function ad(e,t){return new Float32Array([e[0],e[4],e[8],0,e[1],e[5],e[9],0,e[2],e[6],e[10],0,...t,1])}function Vl({origin:e,normal:[t,o,s]}){return[t,o,s,-(t*e[0]+o*e[1]+s*e[2])]}function Xl([e,t,o,s],{view:i,eye:r}){return[i[0]*e+i[4]*t+i[8]*o,i[1]*e+i[5]*t+i[9]*o,i[2]*e+i[6]*t+i[10]*o,e*r[0]+t*r[1]+o*r[2]+s]}function od(e,t){let o=e.gpu(t),s=Float32Array.from(o.lens),i=Array.from(s,(l,d)=>Array.from(o.ramps.slice(d*8,d*8+(Math.round(l)&15)),Math.round)),r=i.map((l,d)=>d),c=l=>{for(;r[l]!==l;)l=r[l];return l};for(let l=0;l<s.length;l++)for(let d=l+1;d<s.length;d++){let n=0;for(let u of i[l])i[d].includes(u)&&n++;n>=2&&(r[c(d)]=c(l))}return s.forEach((l,d)=>{s[d]=(Math.round(l)&31)+c(d)*32}),{...o,lens:s}}function Jn(e){return e.replaceAll("u_pixOn > 0.5","false").replaceAll("u_ao > 0.0","false").replaceAll("u_toneOn > 0.5","false").replaceAll("u_remapLine > 0","false").replaceAll("u_grade > 0.5","false").replace("if (u_gk <= 0.0) return c;","return c;")}function lr(e,t){return e?.length===t.length&&t.every((o,s)=>o===e[s])}function Wl(e,t,{specialize:o,reuseOrder:s,simpleOnly:i}){let r=ur(e),c=t.KIT?.procedural?.sampleCoverage,l=t.ContributionRules??t.KIT?.procedural?.contributionRules,d=t.StableDetail??t.KIT?.stableDetail,n=t.KIT?.cutaway,u;try{let nf=function(a){return of[a]??={transparency:new WeakMap,afterimages:Fa?.history(),clusters:Ji?.history()}},uf=function(a,h,O,U,$,ce,ue,ne,re,Le,Te,De,Be,Ue,ee,je,qe){let Ne=je?.hasFar?je:null,ot=St=>!qe?.[St]&&(!ee||ee.keep[St])&&!x?.hidden(Ne?.codes[St]);function We(St,Lr){if(!ee&&!Ne&&!qe)return St;if(!Lr)return St.filter(ot);let It=0,Br=new Int32Array(St.length);for(let Tr=0;Tr<St.length;Tr+=2)ot(St[Tr])&&(Br[It++]=St[Tr],Br[It++]=St[Tr+1]);return Br.subarray(0,It)}let Ie=h.time??a.lookSnapshot?.time??0,Ze=Le&&Ft?.source===De&&Ft.histories===Te&&Ie<Ft.sceneTime,Dt=Te.get(De);if(!Le||h.order?Te.delete(De):(Dt||Te.set(De,Dt=qo.history()),(h.resetTransparency||Ze)&&Dt.reset()),h.order){u.setOrder(We(h.order,!1)),Ft=null;return}let kt=a.moving??[],Oe=a.back??[],Yr=s&&!a.anim?.bones?.length,si=kt.length?[U,...Be,...Ue]:[],Ir=ce?[ue,ne,re,O.tangent,O.clipNear,+O.ortho]:[];if(Yr&&!$&&(h.changedRows?.length===0||ce&&!a.count&&!h.changedRows)&&!h.resetTransparency&&!Ze&&Ft?.tolerance===Le&&lr(Ft.clock,si)&&(!Le||Ft.histories===Te)&&Ft.quality===ee&&Ft.far===Ne&&(Ft.curveRows===qe||qe&&lr(Ft.curveRows,qe))&&Ft.revision===ce?.orderRevision&&lr(Ft.viewport,Ir)&&lr(Ft.view,O.view)&&lr(Ft.moving,kt)&&lr(Ft.back,Oe)){Ft.sceneTime=Ie;return}let Ri=ce&&Dl(ce,O,ue,ne,re),ci=Le&&Oe.length?new Set(Oe):null,{data:Qt,opticalSplats:ui}=a,Zr=Le?(St,Lr)=>Dt.sort(St,{data:De.data,layout:h.instances,view:O.view,time:Ie,tolerance:Le,depthAt:It=>Lr[It],transparentAt:It=>qo.isTransparent(Qt,It,Qt[It*16+3],ui?.[It*12+3],ci)}):void 0,Ai=ef(a,O.view,U,Ri,ce?.rows,Zr,Be,Ue);u.setOrder(We(Ai,!!ce),!!ce),Ft=Yr?{view:O.view,moving:Int32Array.from(kt),back:Int32Array.from(Oe),clock:si,tolerance:Le,sceneTime:Ie,source:De,histories:Te,revision:ce?.orderRevision,viewport:Ir,quality:ee,far:Ne,curveRows:qe}:null},lf=function(a,h){if(!h?.affectsCleanup&&!h?.fineOff)return null;let O=a.look.detailBudgets,U=ns.get(a);if(U?.definition===O&&U.count===a.count&&U.metadata===a.renderMetadata&&U.tiles===a.fine)return U;let $=h.bind(a),ce=h.affectsCleanup&&Float32Array.from({length:a.count},(re,Le)=>h.flags($(Le))),ue=a.fine;if(ue&&h.fineOff)for(let re=0;re<a.count;re++){let Le=re*12+11;ue[Le]&&$(re)?.fine===!1&&(ue===a.fine&&(ue=ue.slice()),ue[Le]=0)}let ne={definition:O,count:a.count,metadata:a.renderMetadata,tiles:a.fine,fine:ue,flags:ce&&ce.some(Boolean)?ce:null};return ns.set(a,ne),ne},ff=function(a,h,O,U,$){if(!O?.rows)return null;let ce=ss.get(a);if(h.changedRows?.length===0&&ce?.key===U&&ce.data===a.data&&ce.metadata===a.renderMetadata&&ce.count===a.count&&ce.particleStart===$)return ce.selection;let ue=gt.planRows(a,O,{particleStart:$,silhouette:h.silhouetteProtection});return ss.set(a,{key:U,data:a.data,metadata:a.renderMetadata,count:a.count,particleStart:$,selection:ue}),ue},pf=function(a,h,O,U){let $=a.materialPixelStyles,ce=us;if(!ce||ce.group!==h||ce.source!==$||ce.count!==a.count){let ne=$;if(O){ne=new Float32Array((a.count+O.sharedCount)*4),$&&ne.set($.subarray(0,a.count*4));for(let re of O.assets)re.materialPixelStyles&&ne.set(re.materialPixelStyles,(a.count+re.offset)*4)}us={group:h,source:$,rows:ne,count:a.count},Ta.upload(ne,(a.count+(O?.sharedCount??0))*4)}else if(U?.length&&$){if(O)for(let ne of U){let re=ne*512*4,Le=Math.min(re+512*4,a.count*4);ce.rows.set($.subarray(re,Le),re)}Ta.upload(ce.rows,(a.count+(O?.sharedCount??0))*4,U)}else Ta.bind()},df=function(a){if(o&&!Rs&&!a)try{return w??=_(Jn(p.POST_FS))}catch(h){if(e.isContextLost())throw h;Rs=!0}return sf??=_(p.POST_FS)},At=function(a,h,O,U,$){e.bindFramebuffer(e.FRAMEBUFFER,h),e.viewport(0,0,O,U),e.bindVertexArray(S),e.useProgram(a.p),a.set($),e.drawArrays(e.TRIANGLES,0,3)},vf=function(a){if(!a)return null;let h=JSON.stringify(a);return Ns!==h&&(Os=t.PixelLook.prepareTone(a,t.KIT?.procedural?.materials?.blueNoise),Ns=h),Os},hf=function(a){if(!a)return{u_toneOn:0};if(N(12,Yl),Us!==a){let h=Math.max(a.stops.length,a.width),O=a.height+1,U=new Float32Array(h*O*4);a.stops.forEach(([$,ce],ue)=>U.set([...ai(parseInt(ce.slice(1),16)),$],ue*4));for(let $=0;$<a.height;$++)for(let ce=0;ce<a.width;ce++)U[(($+1)*h+ce)*4]=a.thresholds[$*a.width+ce];e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,h,O,0,e.RGBA,e.FLOAT,U),Us=a}return{u_toneOn:1,u_toneCut:a.cutoff,u_toneAmt:a.amount,u_toneN:a.stops.length,u_toneStops:12,u_toneThSize:[a.width,a.height]}},mf=function(a,h,O){if(h===void 0||h===!1)return null;let U=JSON.stringify([h,a.pal,a.paletteRoles,O],(ce,ue)=>ce!=="frames"||!Array.isArray(ue)?ue:(jo.has(ue)||jo.set(ue,++Jl),{rasterFrames:jo.get(ue)}));if(U===ds&&a===vs&&a.renderMetadata===hs&&a.count===ms)return ps;let $=t.PixelLook.preparePaletteConstraints(h,{palette:a.pal,roles:a.paletteRoles,blueNoise:t.KIT?.procedural?.materials?.blueNoise,skipMasks:O,skipDitherRegions:!0,maskSupported:ce=>!!l?.supportsMask(ce)});if($){Vi??=r.texture(),Xi??=L(1024,4,k),Wi=49+Math.ceil(Math.max(...$.palettes.map(re=>re.ranks.length))/4),Hi=Wi+Math.max(...$.palettes.map(re=>(re.grade?.length??0)/3)),$.masked=$.palettes.some(re=>re.maskSource);let ce=$.masked&&Nl($.palettes,l,k);$.textured=!!ce?.texture,Ki=Hi+($.masked?6:0),Yi=Ki+($.palettes.some(re=>re.matchId)?48:0),Ea=Yi+Math.max(...$.palettes.map(re=>re.pairs?.length??0));let ue=Ea+2,ne=new Float32Array(ue*4*$.palettes.length);if($.palettes.forEach((re,Le)=>{let Te=Le*ue*4,De=re.anchor,Be=De?["screen","world","object","view"].indexOf(De.dither):-1;if(ne.set([...De?.origin??[0,0,0],De?.spacing??1,Be,...re.tuning?.fade??[0,0],0],Te+Ea*4),ne.set([re.count,re.packed.length,re.width,re.height],Te),re.mapOnly||re.swatches.forEach((Ue,ee)=>ne.set(Ue,Te+(ee+1)*4)),ne[Te+7]=re.amount,ne[Te+11]=+(re.source==="graded"),ne[Te+15]=re.mapOnly?2:+!!re.grade,ne[Te+19]=re.matchId??0,ne[Te+23]=re.pairs?re.pairs.length+1:0,ne[Te+27]=re.tuning?.scale??1,ne[Te+31]=re.tuning?.screenGain??1,re.reserveAccess?.forEach((Ue,ee)=>{let je=re.count+ee,qe=Math.floor(je/24),Ne=1<<je%24;Ue&1&&(ne[Te+(8+qe)*4+3]+=Ne),Ue&2&&(ne[Te+(10+qe)*4+3]+=Ne)}),re.pairs?.forEach(({slots:Ue,lightness:ee},je)=>ne.set([...Ue,...ee??[-1,1]],Te+(Yi+je)*4)),re.lab?.forEach((Ue,ee)=>ne.set(Ue,Te+(Ki+ee)*4)),ne.set(re.ranks,Te+196),re.grade)for(let Ue=0;Ue<re.grade.length/3;Ue++)ne.set(re.grade.subarray(Ue*3,Ue*3+3),Te+(Wi+Ue)*4);ce?.rows?.[Le]&&ne.set(ce.rows[Le],Te+Hi*4)}),N(8,Vi),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,ue,$.palettes.length,0,e.RGBA,e.FLOAT,ne),Xi.upload(Float32Array.from($.slots(a))),ce?.texture){let{width:re,height:Le,values:Te}=ce.texture;$o??=r.texture(),N(14,$o),e.texImage2D(e.TEXTURE_2D,0,e.R32F,re,Le,0,e.RED,e.FLOAT,Te)}}return ds=U,vs=a,hs=a.renderMetadata,ms=a.count,ps=$,$},_f=function(a,h){_s??=L(1024,10,k);let{data:O,pix:U,renderMetadata:$,surfaceData:ce,anim:ue,count:ne}=a,re=a.rest??ue?.base??O,Le=[a,U,$,ce,re,ne],Te=lr(Go?.sources,Le),De=Te?Go.values:new Float32Array(ne*8),Be=Te?re===O?h:[]:void 0,Ue=(ee,je)=>{let qe=$?.normals;for(let Ne=ee;Ne<je;Ne++){let ot=Ne*3,We=Ne*8,Ie=Ne*16,Ze,Dt;U?.[We]?(Ze=U,Dt=We+3):qe?.[ot]||qe?.[ot+1]||qe?.[ot+2]?(Ze=qe,Dt=ot):ce?.[We]&&(Ze=ce,Dt=We+1);for(let kt=0;kt<3;kt++)De[We+kt]=Ze?.[Dt+kt]??0,De[We+4+kt]=re[Ie+kt]}};if(Be===void 0)Ue(0,ne);else for(let ee of Be)Ue(ee*512,Math.min(ne,(ee+1)*512));_s.upload(De,De.length,Be),Go={sources:Le,values:De}},xf=function(a){if(!a){Aa.bind();return}ni.length!==a.length&&(ni=new Float32Array(a.length));for(let h=0;h<a.length;h+=12)for(let O=0;O<3;O++){let U=h+O*3,$=h+O*4;ni[$]=a[U],ni[$+1]=a[U+1],ni[$+2]=a[U+2],ni[$+3]=a[h+9+O]}Aa.upload(ni)},yf=function(a,h){Pa=0;let O=h.edgeTable?.(a);if(!O?.any||!h.anchors)return;let{count:U,data:$,detail:ce,pix:ue,pats:ne}=a,re=a.reconstructionPose?a._anchors:h.anchors({count:U,data:$,detail:ce,pix:ue,pats:ne});if(!re?.n)return;Es??=r.program(p.SPR_VS,p.SPR_FS),Fs??=P(1,{depth:!0}),Ko??=r.texture(),Yo??=L(768,14,k);let Le=new Float32Array(1152*4);for(let Te=0;Te<32;Te++)Le.set(O.per.subarray(Te*8,Te*8+8),Te*48);O.sprites.forEach((Te,De)=>{let Be=(32+De)*48;Le.set([Te.w,Te.h,Te.ax,Te.sink],Be),Le.set(Te.cells.slice(0,44),Be+4)}),N(12,Ko),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,12,96,0,e.RGBA,e.FLOAT,Le),Yo.upload(re.data),Pa=re.n},gf=function(a,h,O,U,$,ce,ue,ne){if(!a)return null;if(fe??=r.texture(),N(3,fe),a!==Xe||!Me){let{width:re,height:Le,data:Te,uniforms:De}=a.pack();re===tt&&Le===Ye?e.texSubImage2D(e.TEXTURE_2D,0,0,0,re,Le,e.RGBA,e.FLOAT,Te):(e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,re,Le,0,e.RGBA,e.FLOAT,Te),tt=re,Ye=Le),Me=De,Xe=a}return{...Me,u_waterData:3,u_waterView:h.view,u_waterEye:h.eye,u_arrivalPlane:U,u_waterCamera:[h.tangent*h.aspect,h.tangent,+h.ortho],u_waterTime:O,u_waterReflections:$?23:0,u_waterReflectionCount:$?.count??0,u_waterReflectionActive:$?.active??Qe,u_waterReflectionHeights:$?.heights??Qe,u_waterReflectionGrid:$?.grid??[2,1],u_waterReflectionViewport:[ce,ue],u_waterReflectionDetailOn:ne,u_waterProjection:h.projection}},bf=function(a,h){let O=!!a.u_waterAirCount,U=!!a.u_waterLayered,$=!!a.u_waterAtlas,ce=+O+2*U+4*$+8*Number(h);return ke.has(ce)||ke.set(ce,{airPockets:O,layered:U,atlas:$,sources:m({water:!0,airPockets:O,layered:U,atlas:$,environment:h})}),ke.get(ce)},Ot=function(a,h,O,U,$,ce,ue,ne){let re,Le,Te;if($.surfaceFrame?.depthProxy&&(Qi??=fl(e,R,n?.glsl),re=Qi.prepare($.surfaceFrame,O,U)),e.bindFramebuffer(e.FRAMEBUFFER,h.framebuffer),e.viewport(0,0,O,U),$.u_coverageVotePass)e.clearBufferfv(e.COLOR,0,[0,0,0,1]),e.clearBufferfv(e.COLOR,1,Qe),e.disable(e.BLEND);else if($.u_paintPass||$.u_gaussianMaterialPass)e.clearBufferfv(e.COLOR,0,Qe),e.clearBufferfv(e.COLOR,1,Qe),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA);else if($.portalForeground){for(let Ne=0;Ne<h.textures.length;Ne++)e.clearBufferfv(e.COLOR,Ne,Qe);e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA)}else if($.u_idx)e.disable(e.BLEND),$.u_idx===3&&(e.clearBufferfv(e.DEPTH,0,Qe),e.enable(e.DEPTH_TEST),e.depthFunc(e.GREATER)),e.clearBufferfv(e.COLOR,0,Qe),$.u_idx===1&&h.textures.length>1&&e.clearBufferfv(e.COLOR,1,Qe),$.u_idx===1&&h.textures.length>2&&e.clearBufferfv(e.COLOR,2,Qe);else{if(ne){let Ne=ue?ue.skyPrograms??=new Map:le,ot=!!$.layeredGlass,We=+ot+2*!!ne.lit;Ne.has(We)||Ne.set(We,_(ue?wo(ue.airPockets,ue.layered,ue.atlas,!0,ot,ne.lit):Wu(ot,ne.lit))),e.disable(e.BLEND),At(Ne.get(We),h.framebuffer,O,U,{...ce,...ne.uniforms,u_envViewport:[O,U],u_waterViewport:[O,U]})}else{if(ce){let Ne=$.layeredGlass?ue.glassBackground??=_(wo(ue.airPockets,ue.layered,ue.atlas,!1,!0)):ue.background??=_(wo(ue.airPockets,ue.layered,ue.atlas));e.disable(e.BLEND),At(Ne,h.framebuffer,O,U,{...ce,u_waterViewport:[O,U],u_waterBackground:$.background.slice(0,3)})}else e.clearBufferfv(e.COLOR,0,$.background),e.clearBufferfv(e.COLOR,1,[1,0,0,1]);if($.layeredGlass&&!ce){let Ne=h.textures.length-2;e.clearBufferfv(e.COLOR,Ne,$.background),e.clearBufferfv(e.COLOR,Ne+1,[1,1,1,1])}}e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA)}let De=$.surfaces,Be=$.scaleSurfaces,Ue=$.spriteRows,ee=!!(De||Be?.some(Boolean)||Ue?.length),je=!$.u_markPass&&!!$.proxy&&Ae.hasGeometry,qe=!!a.footprints&&g.hasPlanes&&$.u_idx!==3;if(ee||je||qe||$.surfaceFrame?.lighting?.display){let Ne=$.u_splatPaintPass||$.u_coverageVotePass||$.u_gaussianMaterialPass,ot={geometryUpdatesSince:t.SpriteSurface?.geometryUpdatesSince,updatesSince:t.SpriteSurface?.updatesSince??t.KIT?.ecology?.atlasUpdates,cutaway:n?.glsl,projectionPlan:t.SpriteSurface?.projectionPlan,spriteLOD:x?.glsl,samplingPlan:t.SpriteSurface?.samplingPlan,samplingGLSL:t.SpriteSurface?.samplingGLSL,print:I?.print?.glsl};h.ensureDepth(),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL),e.depthMask(!0),e.clearBufferfv(e.DEPTH,0,[1]),e.disable(e.BLEND),Ne&&e.colorMask(!1,!1,!1,!1);let We={...$.surfaceFrame,water:ce,wet:ue,width:O,height:U,glassLayers:!!$.layeredGlass,anchors:$.u_markPass?$.surfaceFrame?.anchors:void 0,coverageFilter:$.coverageFilter};if(We.engraving&&!We.index&&(e.activeTexture(e.TEXTURE0+14),Te=e.getParameter(e.TEXTURE_BINDING_2D)),De)for(let[Ie,Ze]of(Array.isArray(De)?De:[De]).entries()){if(!Ze)continue;let Dt;Ze.brickField?(oi.has(Ze.sceneMeshId)||oi.set(Ze.sceneMeshId,ga(e,{...ot,sharedShaders:tf})),Dt=oi.get(Ze.sceneMeshId)):Dt=bs[Ie]??=ga(e,ot),Ze.sceneMeshId&&e.depthFunc(e.LESS),Dt.draw(Ze,{...We,samplingScale:$.u_materialGridScale??1,geometryCode:$.surfaceFrame?.meshCodes?.get(Ze.sceneMeshId),partGrid:$.spriteGrid}),Ze.sceneMeshId&&e.depthFunc(e.LEQUAL)}if(Be){e.depthFunc(e.LESS);for(let[Ie,Ze]of Be.entries())Ze&&(Vo[Ie]??=ga(e,ot),Vo[Ie].draw(Ze,{...We,samplingScale:$.u_materialGridScale??1}));e.depthFunc(e.LEQUAL)}Ue?.length&&(q??=dl(e,x,n?.glsl),q.draw(Ue,{...We,artScale:$.spriteGrid??[1,1]})),!$.u_markPass&&$.surfaceFrame?.lighting?.display&&(Wo??=ga(e,{cutaway:n?.glsl}),Wo.draw($.surfaceFrame.lighting.display,{...We,lighting:null})),je&&($.u_splatPaintPass&&e.colorMask(!0,!0,!0,!0),Ae.draw({...$.proxy,width:O,height:U,wet:ue,glassLayers:We.glassLayers,scale:$.u_materialGridScale??1},$.u_paintPass||$.u_gaussianMaterialPass?3:$.u_idx||0)),Te!==void 0&&N(14,Te),Hr.bind(),Ne&&e.colorMask(!0,!0,!0,!0),e.depthMask(!1),!$.u_idx&&!$.u_coverageVotePass&&(e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA))}else $.u_idx!==3&&e.disable(e.DEPTH_TEST);a.bindFilterRows?.(),a.footprints&&g.rebind(),a.gaussianMaterials&&D.rebind(),e.useProgram(a.p),a.set({...$,u_markPass:!!$.u_markPass,u_filterMatte:!!$.coverageFilter,u_meshDepthProxy:R,u_geometryDepth:+(ee||je||qe),u_proxyGrid:$.proxy?[$.proxy.width/O,$.proxy.height/U]:[1,1],u_portalCoverPlane:$.u_portalCoverPlane??Qe,u_paintPass:!!$.u_paintPass,u_splatPaintPass:!!$.u_splatPaintPass,u_coverageVotePass:!!$.u_coverageVotePass,u_gaussianMaterialPass:!!$.u_gaussianMaterialPass,u_surfacePeel:!1,u_gaussianNormalCutoff:$.u_gaussianNormalCutoff??0,u_materialGridScale:$.u_materialGridScale??1,u_facingGridScale:$.u_materialGridScale??1,u_spriteLodGrid:$.spriteGrid??[1,1],u_viewport:[O,U],u_lookViewport:[O,U],...$.lookGrid&&{u_lookViewportScale:[$.lookGrid[0]/O,$.lookGrid[1]/U]},u_focal:U/2/$.tangent}),re&&(e.activeTexture(e.TEXTURE0+R),Le=e.getParameter(e.TEXTURE_BINDING_2D),e.bindTexture(e.TEXTURE_2D,re)),qe&&(e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL),e.depthMask(!0),e.colorMask(!1,!1,!1,!1),a.set({u_idx:4}),u.draw(),e.colorMask(!0,!0,!0,!0),e.depthMask(!1),a.set({u_idx:$.u_idx??0})),$.u_idx===3?(u.drawSubset($.indices),e.disable(e.DEPTH_TEST)):u.draw(),re&&N(R,Le),e.disable(e.DEPTH_TEST),e.depthMask(!0)},wf=function(a,h,O,U,$,ce,ue,ne,re,Le,Te,De,Be,Ue){let ee=Te?rt:Fs;ee.resize(O,U),Hr.bind(),N(13,null),N(12,Ko),Yo.bind(),e.bindFramebuffer(e.FRAMEBUFFER,ee.framebuffer),e.viewport(0,0,O,U),e.clearBufferfv(e.COLOR,0,Qe),Te&&e.clearBufferfv(e.COLOR,1,Qe),e.clearBufferfv(e.DEPTH,0,[1]),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS);let je;if(Be||Ue){let qe=[!!re,re?.airPockets,re?.layered,re?.atlas,!!De?.media,!!Be,!!De?.lit,!!Ue].join("/");if(!Do.has(qe)){let Ne=m({water:!!re,airPockets:re?.airPockets,layered:re?.layered,atlas:re?.atlas,environment:!!De?.media,emitterFog:!!De?.lit,relighting:Be,cutaway:Ue?n.glsl:void 0});Do.set(qe,r.program(Ne.SPR_VS,Ne.SPR_FS))}je=Do.get(qe)}else je=re?re.sprites??=r.program(re.sources.SPR_VS,re.sources.SPR_FS):De?.media?cf??=r.program(p.SPR_VS,m({environment:!0}).SPR_FS):Es;return e.useProgram(je.p),je.set({u_anc:14,u_sprTex:12,u_dat:0,u_depth:2,u_idxTex:9,u_pixTex:10,u_view:a.view,u_proj:a.projection,u_vp:[O,U],u_splatPlane:Le,u_spriteCover:Te??Qe,u_rng:a.depthRange,u_time:$,u_keep:t.KIT.pixel.anchorKeep(h,a.footprint),u_ortho:+a.ortho,u_rmpN4:pr.gpu.lens,u_pview:a.view,u_peye:a.eye,u_tanF:a.tangent,u_asp:a.aspect,u_portho:+a.ortho,u_eGap:(ce?.gap??.3)/(2*a.radius),u_tol:3*a.footprint+.02,...ue,...De?.uniforms,...Ue,...Be&&{u_relight:wa},...ue||De?.media||Be?{u_waterSpritePalette:ne,u_rmp4:pr.gpu.ramps}:{}}),e.bindVertexArray(S),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,Pa),e.disable(e.DEPTH_TEST),N(13,ee.textures[0]),ee.textures[1]},$s=function(a,h,O,U,$,ce,ue){let ne=qu(a,h,O,U,$,t.KIT?.reflection,k,ue?.captures&&(Te=>gt.reflectionPlan(ue,Te)));if(!ne?.captures.length)return null;za??=r.texture();let re=[ne.width*ne.grid[0],ne.height*ne.grid[1]];N(23,za),lr(ks,re)||(e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,...re,0,e.RGBA,e.UNSIGNED_BYTE,null),ks=re);for(let Te of ne.captures){let{width:De,height:Be}=Te,Ue=De!==ne.width||Be!==ne.height,ee=Ue?af??=P():rf??=P();ee.resize(De,Be);let je=a,qe=h.instances;qe&&Te.plane.select&&(Ia??=Gi(),je=Ia(a,qe,h.changedRows).world,qe=void 0);let Ne=h.time??a.lookSnapshot?.time??0,ot=bt?.clock(a,h).scene??Ne;je=Vu(je,Te.plane,ot,t);let We={...h,instances:qe,order:void 0,changedRows:void 0,water:!1,reflections:!1,raw:h.raw??!1,outline:!1,dither:0,damp:!1,edges:!1,clean:!1,tone:!1,fade:0,[ri]:void 0,[Co]:Te.plane.id};Ba(je,We,De,Be,ee.framebuffer,Te.camera,Te.equation,0,!0,ce),e.bindFramebuffer(e.READ_FRAMEBUFFER,ee.framebuffer),N(23,za);let Ie=Te.slot%2*ne.width,Ze=Math.floor(Te.slot/2)*ne.height;Ue?(Ts??=r.allocate("Framebuffer"),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,Ts),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,za,0),e.blitFramebuffer(0,0,De,Be,Ie,Ze,Ie+ne.width,Ze+ne.height,e.COLOR_BUFFER_BIT,e.LINEAR)):e.copyTexSubImage2D(e.TEXTURE_2D,0,Ie,Ze,0,0,De,Be)}let Le=h.reflectionDetail!==!1&&a.water.reflectionClusters;return e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,Le?e.NEAREST_MIPMAP_LINEAR:e.NEAREST),Le&&(e.bindFramebuffer(e.DRAW_FRAMEBUFFER,null),e.generateMipmap(e.TEXTURE_2D)),e.activeTexture(e.TEXTURE0),ne},js=function(a,h,O){let U=h.reconstruction??a.look?.reconstruction;if(U===void 0||U===!1)return{world:a,frame:h};let $=a,ce=h.instances,ue=ce?O(a,ce,h.changedRows):null,ne=Kl(t,ue?.world??a,h,U);return ne===(ue?.world??a)?{world:a,frame:h}:{world:ne,frame:{...h,[jl]:{source:$,layout:ce},instances:void 0,changedRows:void 0}}},tn=function(a,h,O,U,$,ce,ue=Qe,ne,re=!1,Le=0){let Te=h[jl],De=Te?.source??a,Be=nf(ue===Qe?0:h[Qn]??1),Ue=Be.transparency,ee=ce??Xr(a,h,O,U),je=t.KIT?.viewPoses;je?.forWorld(a)?.active&&(a=je.frame(a,{...Cr(ee),ortho:ee.ortho},{enabled:h.viewPoses!==!1})),a.shadowLod&&h.shadowArt!==!1&&(a=t.KIT?.shadowArt?.frame(a,ee.shadowFootprint)??a);let qe=a.gaussianHarmonics,Ne=h.gaussianColor??qe?.colorMode??"baked";if(!["baked","rgb","palette"].includes(Ne)||Ne!=="baked"&&!qe)throw new TypeError("Gaussian RGB and palette modes need live imported harmonics");let ot=jc(a,h.gaussianPartProxies??a.gaussianPartProxies),We=Ne!=="baked"&&bo(a,h.gaussianMaterials??a.gaussianMaterials),Ie=Ne==="baked"?h.raw??!1:Ne==="rgb",{outline:Ze=!0,dither:Dt=.35,scale:kt=1}=h,Oe=a.look??{},Yr=!Ie&&ae?.prepare(Oe.stable,h.stable,h.ditherSpace),si=_u(h.splatOrder??Oe.splatOrder,h.surfaceOrder??Oe.surfaceOrder),Ir=h.engraving!==!1&&!!a.engraving,Ri,ci=Ie||re?!1:h.colorClusters??Oe.colorClusters;if(ci!==void 0&&ci!==!1&&!Ji)throw new Error("Color clusters need the Ink Studio KIT");let Qt=Ji?.prepare(ci),ui=Ie||re?!1:h.boundaryCels??Oe.boundaryCels;if(ui!==void 0&&ui!==!1&&!Ho)throw new Error("Boundary cels need the Ink Studio KIT");let Zr=Ho?.prepare(ui,{scenePalette:a.pal,paletteRoles:a.paletteRoles}),Ai=!re&&ue===Qe,St=Ai&&(h.shotCorrections??Oe.shotCorrections),Lr=Ai&&h.captureShotCorrectionSurface===!0,It=t.KIT?.shotCorrections;if((St!==void 0&&St!==!1||Lr)&&!It)throw new Error("Shot corrections need the Ink Studio KIT");let Br=It?.prepare(St),Tr=Qt||Zr,li=Br||Lr,ea=Tr||li,Oa=ue===Qe?h.colorClusterHistory??Be.clusters:Be.clusters;!re&&!Qt?.coherent&&Oa?.clear();let Si=bt?.clock(a,h),mt=Si?.time??h.time??a.lookSnapshot?.time??0,pt=Si?.scene??(h.stepAnimation!==!1&&Oe.pixel?Math.floor(mt*10)/10:mt);if(h.strictContract){if(!bt)throw new Error("Strict frame validation needs the Ink Studio KIT");bt.requirePortable(a,h)}!Ie&&a.pal.length>Nt&&!gs.has(a.pal)&&(gs.add(a.pal),console.warn("Ink Studio WebGL resolves the first "+Nt+" of "+a.pal.length+" scene swatches. Use raw: true to draw baked colors without palette resolve."));let Ua=bt?.hasStages(a,h)&&!bt.compatibility(a,h).length,ta=h.passQuality??Oe.passQuality;if(ta&&!gt)throw new Error("Pass quality needs the Ink Studio KIT");let fi=gt?.prepare(ta),ra=fi?JSON.stringify([ta,h.silhouetteProtection??Oe.silhouetteProtection]):"",Ga=h.cutaway??Oe.cutaway;if(Ga&&!n)throw new Error("Cutaways need the Ink Studio KIT");let Rr=n?.prepare(Ga),Qr=Rr&&n.uniforms(Rr,ee.setback);if(!re&&ue===Qe){let J=Rr?JSON.stringify(Rr):null;J!==Ls&&(ht=!1),Ls=J}let $a=h.stableDetail??Oe.stableDetail;if($a&&!d)throw new Error("Stable detail needs the Ink Studio KIT");let ja=d?.prepare($a),qa=ja?.texture??[0,0],Va=ja?.geometry??[0,0],Xa=[...qa,...Va];lr(Is,Xa)||(ht=!1),Is=Xa;let ia=qo?.transparency(h.stableTransparency??Oe.stableTransparency)?.depthTolerance??0,Ar=Ie?null:Je?.prepare(Oe.detailBudgets),nt=!Ie&&(h.coverageAware??Oe.coverageAware)===!0,Sf=Ie||nt?void 0:h.tone??Oe.tone,Jr=vf(Sf),on=!Ie&&(h.clean??(!!Oe.clean&&!Jr?.preserveDots)),Hs=Ar?.affectsCleanup&&(on||Ar.enablesCleanup||Ar.protectsGaps),Ks=h.paletteConstraints??Oe.paletteConstraints,Ef=h.areaLights!==!1&&a.areaLights?.length||Array.isArray(h.areaLights)&&h.areaLights.length||(h.volumeLighting??a.volumeLighting)?.spots?.length,nn=at&&(h.relighting??a.relighting),Wa=h.shotLighting??a.shotLighting;if(Wa&&!Po)throw new Error("Shot lighting needs the Ink Studio KIT");let sn=h.coverageFilter??Oe.coverageFilter;sn!==pe&&(de=Ic.prepare(sn),pe=sn);let Lt=h.instances,cn=h.afterimages??Oe.afterimages,Ys=!re&&!h.order&&cn!==void 0&&cn!==!1;if(Ys&&!Fa)throw new Error("Afterimages need the Ink Studio KIT");let Ei=Ys?Fa.prepare(cn):[],Ff=i||Ei.length?null:$s(a,h,ee,O,U,0,fi);if(Lt&&(ge.has(a)||Ua||fi?.rows||Ei.length||Qt||h[ri]||h.order||ia||nn||Wa||Ef||Yr?.anchorSpaces?.size||a.engraving||a.splatFootprints||Pr(Lt).hasSplatFootprints||a.opticalSplats||Pr(Lt).hasOpticalSplats||!Ie&&(Ks||Oe.pixel&&a.pix||Hs||Ar?.fineOn||Ar?.fineOff||de?.varied))){Ia??=Gi();let J=Ia(a,Lt,h.changedRows);a=J.world,h={...h,changedRows:J.changedRows},Lt=void 0}let Zs=h.afterimageHistory??Be.afterimages,aa=Le;if(!re&&(h.resetAfterimages||!Ei.length)&&Zs?.clear(),Ei.length){let J=Zs.frame(a,mt,Ei,{source:De,layout:Te?.layout??h.instances,poseTime:pt,bornAt:h.bornAt,withdrawal:h.sampleWithdrawal??a.sampleWithdrawal??0});J.length&&(aa=a.count,a=Fa.append(a,J))}let zf=!i&&Ei.length?$s(a,{...h,instances:Lt},ee,O,U,aa,fi):Ff,Jt=Ua&&bt.stagePlan(a,h,pt,{skipMasks:h.lookMasks===!1,blueNoise:J=>t.KIT.procedural.materials.blueNoise(J),query:()=>t.KIT.world.query.fromScene(a,pt)}),oa=ff(a,h,fi,ra,aa||a.count),dt=!Ie&&mf(a,Ks,h.lookMasks===!1),na=!Ie&&!Jt&&!nt&&!!(Yr?.anchorSpaces?.size||dt?.palettes.some(J=>J.anchor&&J.anchor.dither!=="screen")),Sr=!!dt?.masked;Sr&&!nt&&(we??=P(2));let Ha=!re&&ue===Qe,Qs=h.protectedPixels??Oe.protectedPixels;if(Ha&&Qs&&!G)throw new Error("Protected pixels need the Ink Studio KIT");let Js=Ha&&Qs&&G.prepare(Oe.protectedPixels,h.protectedPixels,{scenePalette:a.pal,paletteRoles:a.paletteRoles}),ec=Ha&&(h.highlightCels??a.highlightCels),tc=Ha&&!nt&&(h.shoreFoam??a.shoreFoam),un=Rr&&(J=>n.margin(Rr,...J,-(ee.view[2]*J[0]+ee.view[6]*J[1]+ee.view[10]*J[2]+ee.view[14])-ee.setback)>=0),sa=Js?G.project(Js,a,ee,{w:O,h:U,time:pt,clip:un}):null,rc=tc&&j?.frame(tc,a,ee,{w:O,h:U,time:mt,clip:un}),ln=ec&&ve?.prepare(ec,{scenePalette:a.pal,paletteRoles:a.paletteRoles}),Nr=rl(a,h);if(Nr&&!t.KIT?.curveSplats?.renderKernel)throw new Error("Finite curves need the Ink Studio KIT");let Ka=typeof h.hybridDepthFrame=="function",ic=!!(sa?.coordinates.size||rc?.length||ln?.length||h[ri]?.depth||li),ac=ic||Ka||Nr,er=ac?he??=P(3):Sr&&!nt?we:Ce,Er=h.water!==!1&&a.water?.count?a.water:null,fn=t.KIT?.pixel,lt=!Ie&&!!(Oe.pixel&&a.pix&&fn?.gpu),Ut=Ie?null:a.glass,tr=!Ie&&!nt&&!Jt&&!Er&&!Ut&&!ne&&ue===Qe&&!re&&!ot&&Ne==="baked"?de:null,oc=a.ao?a.ao.k??.5:0,Ya=t.PixelLook.framePalette?.(a,h,{grading:!Ie&&!Jt,tone:!Ie&&!nt})??{grade:h.ignoreLookGrade?void 0:a.anim?.grade},nc=!Ie&&!Jt&&!re&&!Jr&&!!Ya.grade;if(i){let J=Object.entries({"per-pixel materials":lt,"glass beams":Ut,"ambient occlusion":!Ie&&!Jt&&oc>0,"tone mapping":Jr,"palette grading":nc,"palette constraints":dt,"spatial dither":na,"coverage filtering":tr,"coverage-aware resolve":nt,water:Er}).filter(([,xe])=>xe).map(([xe])=>xe);if(J.length)throw new Error(`Ink Studio WebGL simple resolve does not support ${J.join(", ")}. Disable these features or use resolve: 'auto'.`)}let Za=Array.isArray(Oe.optics)&&Oe.optics.some(J=>J.driver)?h.time??a.lookSnapshot?.time??0:void 0;!Ie&&Er&&(Oe.optics!==wt||a!==ut||Za!==wi)&&(wt=Oe.optics,ut=a,wi=Za,Wr=t.RenderStages?.optics(Oe.optics,{palette:a.pal,roles:a.paletteRoles,time:Za,query:()=>a.lookSnapshot?.query??a.surfaceEffects?.query??t.KIT?.world?.query.fromScene(a,Za),blueNoise:t.KIT?.procedural?.materials?.blueNoise}));let Qa=Ie?null:Wr;Er&&(Er!==Ge||dt!==Rt||Qa!==xt)&&(Ge=Er,Rt=dt,xt=Qa,yt=(dt||Qa)&&Er?.mapColors?Er.mapColors((J,xe)=>Qa?.transform({kind:"medium",medium:J,mediumKind:xe})??t.PixelLook.mediumTransform(dt,{medium:J,mediumKind:xe})):Er);let dr=Er?yt:null;dr&&(ze??=P(3),me??=P(3));let qt=!1;if(nt&&(a.refract??6)>0&&M>=(dr?5:4)){if(a!==xs||a.data!==ys||h.changedRows?.length!==0){let J=[];for(let xe=0;xe<a.count;xe++)Math.round(a.data[xe*16+11])&256&&J.push(xe);lr(Zi,J)||(Zi=Int32Array.from(J)),xs=a,ys=a.data}qt=!!Zi?.length}qt&&(Fe??=P(1,{depth:!0}),Fe.resize(O,U),dr?it??=P(5):He??=P(4));let zt=dr?qt?it:ze:qt?He:Re,vr=dr?me:Pe,sc=je?.source(a)??a,ca=sc!==Dr||a.data!==Zo||a.count!==Qo||Lt!==La,ua=!!(a.materialPixelStyles||Lt&&Pr(Lt).hasMaterialPixelStyles),cc=h.splatCoverage??Oe.splatCoverage??"legacy",uc=l?.coverageMode?.(cc)??["legacy","continuous","soft"].indexOf(cc);if(uc<0)throw new RangeError("Splat coverage must be legacy, continuous or soft");let lc=h.coverageVote??Oe.coverageVote,hr;if(lc&&!tr&&!Ie&&!re&&!Jt&&!Jr&&!lt&&!dt&&!na&&!dr&&!Ut&&!Lt&&!ot&&ue===Qe&&!ne&&(Y??=Mc(e,{samples:P(2),source:P(),resources:r,table:L,program:_,textureUnit:N,fullscreen:At,maxSize:k,paletteSize:Nt}),Y.prepare(a,lc,Math.min(a.pal.length,Nt)))){if(hr=Y,O*2>Math.min(k,jt[0])||U*2>Math.min(k,jt[1]))throw new RangeError("Coverage vote samples exceed the device viewport or texture limit");hr.samples.resize(O*2,U*2),hr.source.resize(O,U)}let Tt=!tr&&!na&&!Ie&&!Nr&&!Jt&&!Jr&&!lt&&!nt&&(h.colored??!0),ei=lf(a,Ar),mr=!!Hs&&!!ei?.flags,fc=mr&&Ar.protectsGaps,Fi=fc&&!Tt,la=on||mr&&Ar.enablesCleanup,fa=!tr&&!na&&!Ie&&!Jt&&!Jr&&!nt&&!Tt&&!dt&&!!Oe.pixel&&h.damp!==!1,Ja=Tt?2:1,zi=O*Ja,Mi=U*Ja;if(zi>k||Mi>k||zi>jt[0]||Mi>jt[1])throw new RangeError("Ink Studio frame exceeds the WebGL viewport or texture size limit");$||(e.canvas.width!==O&&(e.canvas.width=O),e.canvas.height!==U&&(e.canvas.height=U));let Mf=O!==$t.width||U!==$t.height;(ca||ra!==Bs||Mf||$!==zs||ei!==Ms||!fa||dr!==vt||dr&&h.time!==oe)&&(ht=!1),zt.resize(zi,Mi),vr.resize(Tt?O:1,Tt?U:1);let pn=ic||!!Qt||!!Zr||!!h[ri]||lt||!!dt&&!nt||mr,dn=pn||Ka||Nr;er.resize(dn?O:1,dn?U:1);let eo=qe&&h[Ln];eo&&(te??=P(),te.resize(O,U)),mr&&($i??=L(512,7,k)),ua&&(Ta??=L(512,16,k)),Ee.resize(lt?O:1,lt?U:1),ne&&lt&&h.edges!==!1&&(rt??=P(2,{depth:!0})),la&&ar.resize(O,U);let pa=We&&Ne==="palette";pa&&(_e??=fu({target:P,program:_,textureUnit:N,fullscreen:At}),_e.resize(O,U),ht=!1);let Or=!Ie&&hu(a,h.splatPaint??a.splatPaint);Or&&(ye??=mu({table:L,target:P,maxSize:k,program:_,textureUnit:N,fullscreen:At}),ye.resize(O,U),ht=!1),fa&&($t.resize(O,U),$e.forEach(J=>J.resize(O,U)));let Ci=a.paintCorrections,Fr=a.data,vn=!1;if(Ci&&h.paintCorrections!==!1){qi?.length!==a.count*16&&(qi=new Float32Array(a.count*16)),qi.set(a.data.subarray(0,a.count*16));let{view:J,ortho:xe,eye:Ve}=ee;vn=Ci.paint(qi,a.pal,{direction:[J[2],J[6],J[10]],...xe?{}:{eye:Ve}}),Fr=qi}let to=vn?ee.view:void 0;Jt&&(Fr=bt.materialData(Jt,a,Fr));let Ur=Ne==="baked"&&Nu(t,a,h,ee,mt,pt,Fr,lt);Ur&&(Fr=Ur.data),(Ur||Ti)&&(ht=!1),(to||Ra)&&(!to||!Ra||!lr(to,Ra))&&(ht=!1),Ra=to;let pi=lt&&(vn||!!aa||!!a.opticalSplats);pi&&(ji??=P(2),ji.resize(O,U));let di=ue===Qe?Qe:Xl(ue,ee),ti=Si?.direction??T?.prepare(Oe.artDirection,h.artDirection),Gr=Si??T?.motion(ti,mt,h.skyTime??mt,pt),ro=Gr?[Gr.falling,Gr.rain]:[pt,pt],hn=ro.some(J=>J!==pt)||["foliage","cloth","rain","water","emissive"].some(J=>ti?.cadence[J]!==void 0),io=ti?.windResponse,mn=Z&&W&&(hn||io?.water||io?.emissive)&&(h.windField??a.windField??a.weatherBinding),da=()=>[0,0],_n=[0,0];if(mn){let J=Z.timeline(a,h,mt,ti,t.KIT?.weather?.tracks),xe=Z.opticalWeather(a,h,J,h.weatherFronts!==!1),Ve=Z.wind(a,h,{...J,weather:xe}),wr=Ct=>Ve.windAt?.(ti?.cadence[Ct]===void 0?J.skyTime:h.skyTime??Gr[Ct])??Ve.wind.velocity;da=Ct=>W.frame(wr(Ct)).flex,ti?.cadence.rain!==void 0&&(_n=wr("rain"))}let Et=gf(dr,ee,Gr?.water??pt,ue,zf,O,U,h.reflectionDetail!==!1);Et&&(Et.u_waterWindGain=(io?.water??0)*Math.hypot(...da("water")));let Ke=ie.prepare(a,h,ee,mt,O,U,re,ue);(Ke||Cs)&&(ht=!1),Cs=!!Ke;let ct=Et&&bf(Et,!!Ke?.media);Ir=h.engraving!==!1&&!!a.engraving,Ir&&(ht=!1);let ao=(h.splatFootprints??Oe.splatFootprints)!==!1&&!!a.splatFootprints?.styles.length,pc;if(ao){if(!f)throw new Error("Splat footprints need the Ink Studio KIT");g??=Pu(e,f,r,K,k),pc=g(a)}let Pi=!!a.opticalSplats;if(Pi){let J=t.KIT;ka=J.optical.frame(a,ee,J.splatFrames.create(a,pt,J.M),null,ka),as??=L(1536,Io,k),as.upload(ka)}(Pi||os)&&(ht=!1),os=Pi;let va=t.KIT,dc=(nn||Wa)&&va.splatFrames.create(a,pt,va.M),$r;if(nn){let J=va.environmentFrame.timeline(a,h,mt,va.artDirection.prepare(Oe.artDirection,h.artDirection),va.weather?.tracks);$r=at.rows(a,at.frame(a,h,J),dc,null,ts),$r&&(ts=$r)}if(Wa){let J=Po.frame(a.shotLighting,h.shotLighting,mt),xe=Po.rows(a,J,dc,$r,rs);xe&&xe!==$r&&(rs=xe),$r=xe}let _r=!!$r;_r&&(es??=L(512,wa,k),es.upload($r));let jr=se.prepare(a,h,mt,re,ee),Cf=ln?.length&&ve.frame(ln,a,ee,{w:O,h:U,time:mt,lights:jr?.areas??[],cutoutShadows:h.cutoutShadows,shadowShells:h.shadowShells,spriteSurfaces:h.spriteSurfaces===!1?!1:a.spriteSurfaces,spriteAtlases:h.spriteAtlases===!0?a.spriteAtlases:h.spriteAtlases,spriteAtlasMode:h.spriteAtlasMode,clip:un});_r=se.compose(jr,a,pt,$r,_r),se.fog(jr,a,h),jr&&(ht=!1,Ke&&(Ke.emitters=jr,Ke.uniforms={...Ke.uniforms,...jr.uniforms})),Ke&&(Ke.lit=!!(Ke.lit&&jr)),(_r||is)&&(ht=!1),is=_r;let oo=ei?.fine??a.fine,vc=!Ie&&!!oo,qr=ql(a.pal),vi=Math.min(a.pal.length,Nt),rr=a.fog??{},xn=h.previousWorld&&h.previousWorld===Dr&&Dr.data===Zo&&a.count===Qo&&!Lt&&!La&&!Ci&&!Dr.paintCorrections&&!a.anim&&!Dr.anim,hi=!ca||xn?h.changedRows:void 0,yn=Jt||Ps||Ur||Ti?void 0:hi&&Ci?[...new Set([...hi,...Ci.dirtyRows.filter(J=>J*512<a.count)])]:hi,ha;if(Lt)Gs??=Ll(L,Hr,k),ha=Gs.bind(Lt,a,yn,La!==Lt,Fr);else if(Ir){if(!I)throw new Error("Engraving needs the Ink Studio KIT");b??=Ru(I);let J=b(a,Fr,yn,h.engravingLight??[-.45,.8,.55]);Hr.upload(J.data,J.data.length,J.changedRows),Ri=J.uniforms}else Hr.upload(Fr,a.count*16,yn);let xr,gn=+(h.facingColors===!1)|+(h.directionalColors===!1)<<1;if(!Ie&&gn!==3&&ki&&a.surfaceData&&(Bo.has(a)||Bo.set(a,ki.table(a,(J,xe)=>No.prepareFacing(J,a.pal,a.paletteRoles,xe),J=>No.prepareDirection(J,a.pal,a.paletteRoles))),xr=Bo.get(a),xr)){Oo??=L(ki.width,Lo,k);let J=ki.pose(xr,a,pt,(xe,Ve)=>t.KIT.splatFrames.create(xe,Ve,t.KIT.M));xr!==fs||J?Oo.upload(xr.data):Oo.bind(),fs=xr}if(ua&&pf(a,Lt,ha,hi),vc&&(ca||Jo!==oo)){let J=xn&&!ei&&Jo===Dr.fine?h.changedFineRows:void 0;Uo.upload(oo,a.count*12,J),Jo=oo}else Uo.bind();xf(a.anim?.bones),_r=ge.compose(a,h,ee,pt,_r),ge.has(a)&&(ht=!1);let hc=[ee.view[2],ee.view[6],ee.view[10]];if(De.spriteReconstruction&&!x)throw new Error("Sprite reconstruction needs the Ink Studio KIT");let bn=De.spriteReconstruction&&x.resolve(De,{eye:ee.eye,back:hc,ortho:ee.ortho,focal:ee.projection[5]*U*.5,setback:ee.setback,time:mt,mode:h.spriteReconstruction}),Vt=bn?.mask,nr=bn?.rows;Vt?(C??=L(128,E,k),V!==Vt?C.upload(Float32Array.from(Vt.codes)):C.bind(),Vt!==V&&(ht=!1)):V&&(ht=!1),V=Vt,De.spriteReconstruction&&!re&&ue===Qe&&h.spriteReconstructionFrame?.(bn??{geometryRows:De.count,states:[]});let mc=c?.amount(h.sampleWithdrawal??a.sampleWithdrawal??0)??0,_c=a.meshes===void 0||h.meshes===!1?[]:t.KIT.sceneMeshes.layers(a,h.meshes).filter(J=>!x?.hidden(Vt?.meshCodes.get(J.sceneMeshId))),xc=t.KIT?.procedural?.brickMeshes,Di=a.brickMeshes?xc.layers(xc.frame(a,h.brickMeshes)):[],yc=h.spriteSurfaces===!1?null:a.spriteSurfaces,wn=[yc].flat().concat(_c,Di),yr,ma,gr,Gt;if(tr){if(O*2>Math.min(k,jt[0])||U*2>Math.min(k,jt[1]))throw new RangeError("Coverage filtering exceeds the device viewport or texture limit");H??=Bc({target:P,table:L,maxSize:k,program:_,textureUnit:N,fullscreen:At}),Gt=H.prepare(a,tr,O,U,Nr)}if(na){if(!ae)throw new Error("Spatial dither needs the Ink Studio KIT");z??=Su(ae,L,k),yr=z(a,Yr||void 0,h.changedRows,ee.view),v??=P(2,{floating:!0}),v.resize(O,U)}h.engraving!==!1&&(Nr&&a.engraving||wn.some(J=>J?.surfaceCharts?.some(xe=>xe.engraving||J.sceneMeshId&&a.look?.engraving)))&&(A??=Au(I,L,k,t.KIT?.curveSplats?.renderKernel),ma=A(a,wn,h,Nr)),(yr||ma||tr)&&(Aa.bind(),Hr.bind());let kn=Nr&&{time:pt,restMarks:yr,engraving:ma,filter:tr,drawOrder:h.order,planes:[di,ne?.plane],geometryCode:Vt&&(J=>Vt.codes[J]),curveSubdivision:Rr?!1:h.curveSubdivision??Oe.curveSubdivision,strandLod:(h.curveLod??Oe.curveLod)!==!1&&!Rr&&!ne&&!re&&!di.slice(0,3).some(Boolean),strandForbidden:Pi?J=>ka[J*t.KIT.optical.stride+3]:void 0,keep:J=>(!oa||oa.keep[J])&&!x?.hidden(Vt?.codes[J]),visible:c&&(J=>c.visible(J,mc))},Bt=kn&&Gn(t.KIT,a,Fr,ee,O,U,kn);if(uf(a,h,ee,pt,ca,ha,O,U,kt,ia,Ue,De,ro,_n,oa,Vt,Bt?.rows),lt){let J=Ur?.pixels??a.pix;if(ca||pr?.world!==a||pr.values!==a.pix||pr.ramps!==a.ramps||pr.rampOff!==a.rampOff||pr.patterns!==a.pats){let xe=!Ur&&!Ti&&xn&&pr?.world===Dr&&pr.values===Dr.pix?h.changedPatternRows:void 0;Sa.upload(J,a.count*8,xe);let Ve=od(fn,a);yf(a,fn),pr={world:a,values:a.pix,ramps:a.ramps,rampOff:a.rampOff,patterns:a.pats,gpu:Ve}}else if(Ur||Ti||a.anim?.dynamicPatternNormals){let xe=!Ur&&!Ti&&hi?[...new Set(hi.map(Ve=>Math.floor(Ve/2)))]:void 0;Sa.upload(J,a.count*8,xe)}else Sa.bind()}let{colorGrade:Pf}=Ya,sr=null;if(nc){sr=qr.slice();for(let J=0,xe=Math.min(vi*3,Ya.grade.length);J<xe;J++)sr[J]=Ya.grade[J]}Sr&&_f(a,hi),dt?.textured&&N(14,$o),dt&&(nt||Sr)&&(Xi.bind(9),N(8,Vi)),e.disable(e.SCISSOR_TEST),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE),e.disable(e.STENCIL_TEST),e.colorMask(!0,!0,!0,!0),e.depthMask(!0),e.blendEquation(e.FUNC_ADD),ot&&(Ae??=Xc(e,r,L,k));let no=B(qe,Ne!=="baked");We&&(D??=lu(e,L,k));let Df=We&&D.bind(We,h.gaussianLight??a.gaussianLight),Xt=ot&&{width:O,height:U,scale:1,camera:ee,clip:di,plane:ue,gaussian:no,degree:qe.degree,range:[...ee.depthRange,rr.start??1,rr.max??0],fog:ai(a.pal[rr.c??0]??0)},If=Xt&&Ae.prepare(ot,Xt);if(Xt&&(ht=!1),(Di.length!==Xo.length||Di.some((J,xe)=>J!==Xo[xe]))&&(ht=!1),Xo=Di,oi.size&&!re&&ue===Qe){let J=new Set(Di.map(xe=>xe.sceneMeshId));for(let[xe,Ve]of oi)J.has(xe)||(Ve.dispose(),oi.delete(xe))}let br=_c.length||Di.length?wn:yc,mi=t.KIT?.sceneMeshes?.proxyPlan(a,h.splatDepthProxies,h.splatProxyTolerance);(mi||ws)&&(ht=!1),ws=!!mi;let so=h.spriteSurfaces!==!1&&h.scalePreviews!==!1&&a.scalePreviews,zr,Tn;if(si&&!re){let{layers:J,maxSplats:xe,maxPixels:Ve,region:wr}=si,Ct=u.count,Ht;ue!==Qe||ne||Lt||dr||Ke||qt||pn||Nr||pa||Or||hr||yr||tr||Jt||mi||br||so||Vt||nr?.length||jr?.display||Xt||ao&&g.hasPlanes||Qr?Ht="composition":Ct<2?Ht="splat-count":Ct>xe?Ht="splat-budget":zi*Mi+(Tt?O*U:0)>Ve?Ht="pixel-budget":(Se??=wu(e,{target:P,table:L,maxSize:k,textureUnit:N,fullscreen:At,program:_}),Se.prepare(a)||(Ht="no-normals")),Ht||(zr={layers:Math.min(Ct,J),overflow:Ct>J,region:wr},ht=!1),Tn={mode:Ht?"center":"surface",reason:Ht,splats:Ct,layers:zr?.layers??0,passes:zr?(zr.layers+Number(zr.overflow))*(Tt?2:1):0}}let st=u.programFor({water:!!ct,airPockets:ct?.airPockets,layered:ct?.layered,atlas:ct?.atlas,portal:ue!==Qe||!!ne,gaussianDegree:no?qe.degree:void 0,splatPaint:!!Or,gaussianProxy:!!Xt,depthMeshProxy:!!mi,gaussianMaterials:!!We,coverageVote:!!hr,coverageFilter:!!Gt?.centerMatte,surfaceOrder:!!zr,instances:!!ha,contributions:nt&&!!dt,masked:Sr,textured:dt?.textured,layeredGlass:qt,engraving:Ir,marks:!!yr,footprints:ao,materialStyles:ua,facingColors:xr&&ki,environment:Ke?.media,emitterFog:!!Ke?.lit,relighting:_r,optical:Pi,cutaway:!!Qr,spriteReconstruction:!!Vt});st.bindFilterRows=Gt?.centerMatte?Gt.bindRows:void 0,st.footprints=ao,st.gaussianMaterials=!!We,e.useProgram(st.p);let Rn=a.grow??{};st.set({u_data:0,u_bones:4,u_fine:7,u_filterRows:Fn,...no&&{...no,u_eye:ee.eye},...If,...Df,...zr&&Se.uniforms,...xr&&{u_facingRows:Lo,u_facingCount:xr.count,u_disabledViewColors:gn,u_facingPattern:lt},...Vt&&{u_spriteLod:E,u_spriteLodCount:Vt.codes.length},...ha&&{u_instances:15},u_fineOn:+vc,u_fpal:qr,u_view:ee.view,...ua&&{u_materialStyles:16,u_materialPatterned:lt,u_materialStylesOn:!Ie},u_proj:ee.projection,u_time:pt,u_scale:kt,u_ortho:+ee.ortho,u_motionCadence:hn,u_rainWind:_n,u_motionWind:!!mn&&(ti?.cadence.foliage!==void 0||ti?.cadence.cloth!==void 0),...hn&&{u_effectTimes:[Gr.foliage,Gr.cloth,ro[0],Gr.emissive],u_waterAndRainTime:[Gr.water,ro[1]]},...mn&&{u_effectWind:[...da("foliage"),...da("cloth")]},u_emissiveWind:(io?.emissive??0)*Math.hypot(...da("emissive")),...dt&&(nt||Sr)&&{u_constraintSlots:9,u_constraintRows:8,u_constraintDefault:dt.defaultSlot,u_constraintMap:Wi,u_constraintMask:Hi,u_constraintLab:Ki,u_constraintPairs:Yi,u_lookSites:10,u_maskTextures:14,u_maskTime:mt,u_lookProjection:ee.projection,u_lookRadius:ee.radius,u_lookOrtho:+ee.ortho,u_pal:qr,u_n:vi,u_grade:+!!sr,u_out:sr??qr,u_toneOn:0,u_lookGrid:[O,U]},u_arrivalPlane:ue,u_splatPlane:di,...qt&&{u_glassBoundary:13,u_glassTolerance:ia},u_sampleWithdrawal:mc,u_born:[h.bornAt??0,Rn.rate??1,Rn.fade??.5,Rn.loop??0],u_detailTexture:qa,u_detailGeometry:Va,u_crisp:+!Ie,u_splatCoverage:uc,u_dilate:Ie?.3:.15,u_near:ee.clipNear,u_paintMarker:Ci?.marker??0,u_afterimageStart:aa,...pc,...Ri,...yr?.uniforms,u_screenPrintOn:h.screenPrint!==!1,u_brushworkOn:h.brushwork!==!1,...Pi&&{u_optical:Io},..._r&&{u_relight:wa},u_fog:ai(a.pal[rr.c??0]??0),u_fogp:[rr.start??1,rr.max??0,...ee.depthRange],...Et,...Ke?.uniforms,...Qr});let An=a.gaussianHarmonics&&h[In],co=[...ai(a.pal[0]),An?0:1],Mt=ee.tangent,gc=t.KIT?.procedural?.lod?.preview;if(so&&!gc)throw new TypeError("Scale previews need the Ink Studio KIT");let Mr=so?gc.surfaces(so,{view:ee.view,width:O,height:U,focal:U/(2*Mt),ortho:ee.ortho,near:ee.clipNear,far:ee.clipFar},re||ue!==Qe?void 0:h.scalePreviewFrame):void 0,Wt={depthProxy:mi,meshCodes:Vt?.meshCodes,lighting:jr,environment:Ke,view:ee.view,projection:ee.projection,range:[...ee.depthRange,rr.start??1,rr.max??0],fog:ai(a.pal[rr.c??0]??0),arrivalPlane:ue,clip:di,section:Qr,paletteSampling:h.paletteSampling,surfaceNormals:h.surfaceNormals,anchors:yr,engraving:ma,eye:ee.eye,back:hc,ortho:ee.ortho,sun:nr?.length?x.light(a.liveSun,h.liveSun,mt):void 0};if(qt){N(13,null);let J=oa?Zi.filter(xe=>oa.keep[xe]):Zi;Ot(st,Fe,O,U,{u_idx:3,u_snap:1,u_hard:0,tangent:Mt,indices:J,surfaceFrame:{...Wt,lighting:void 0}}),N(13,Fe.textures[0])}if(Ot(st,zt,zi,Mi,{u_idx:0,u_snap:+(!Ie&&!Tt),u_hard:0,u_materialGridScale:Ja,background:co,tangent:Mt,proxy:Xt,lookGrid:nt&&[O,U],layeredGlass:qt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,spriteGrid:[O/zi,U/Mi],surfaceFrame:Wt},Et,ct,Ke),Tt&&Ot(st,vr,O,U,{u_idx:0,u_snap:1,u_hard:0,background:co,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:Wt},Et,ct,Ke),zr){let J=function(xe,Ve,wr,Ct){let Ht=xu(zr.region,xe.width,xe.height);return Se.draw(xe,ee,co,{...zr,rect:Ht},Ve,_t=>{Hr.bind(),st.footprints&&g.rebind(),st.gaussianMaterials&&D.rebind(),e.useProgram(st.p),st.set({..._t,u_snap:wr,u_materialGridScale:Ct,u_facingGridScale:Ct,u_viewport:[xe.width,xe.height],u_focal:xe.height/(2*Mt)}),u.draw()})};zt=J(zt,0,+(!Ie&&!Tt),Ja),Tt&&(vr=J(vr,1,1,1))}if(Tn&&h.surfaceOrderReport?.(Tn),An&&An((Tt?vr:zt).framebuffer),eo&&(Ot(st,te,O,U,{u_idx:1,u_snap:1,u_hard:0,u_gaussianNormalCutoff:eo.cutoff,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:{...Wt,index:!0}},Et,ct,Ke),eo.read(te.framebuffer)),pa&&Ot(st,_e.coverage,O,U,{u_idx:0,u_snap:1,u_hard:0,u_gaussianMaterialPass:!0,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:Wt},Et,ct,Ke),Or&&(st.set({u_splatPaintRows:ye.bind(Or.mask),u_splatPaintCount:Or.mask.count}),Ot(st,ye.mask,O,U,{u_idx:0,u_snap:1,u_hard:0,u_paintPass:!0,u_splatPaintPass:!0,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:Wt},Et,ct,Ke)),pi&&Ot(st,ji,O,U,{u_idx:0,u_snap:1,u_hard:0,u_paintPass:!0,tangent:Mt,lookGrid:nt&&[O,U]},Et,ct,Ke),dn&&Ot(st,er,O,U,{u_idx:1,u_snap:1,u_hard:0,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:{...Wt,index:!0,graphDepth:ac}}),yr&&(yr.bindSites(),Ot(st,v,O,U,{u_idx:1,u_markPass:!0,u_snap:1,u_hard:0,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:{...Wt,index:!0}}),gr=v),ne){ne.environment=Ke;let J={u_snap:+(!Ie&&!Tt),u_hard:0,u_portalCoverPlane:ne.plane,tangent:Mt,proxy:Xt&&{...Xt,clip:ne.plane},surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:{...Wt,clip:ne.plane}};Ot(st,ne.buffer,O,U,{...J,u_idx:2,surfaceFrame:{...J.surfaceFrame,index:!0,portalCover:!0}}),Ot(st,ne.foreground,O,U,{...J,u_idx:0,portalForeground:!0},Et,ct,Ke)}hr&&Ot(st,hr.samples,O*2,U*2,{u_snap:0,u_hard:0,u_coverageVotePass:!0,u_materialGridScale:2,tangent:Mt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,spriteGrid:[.5,.5],surfaceFrame:Wt});let Ii=er,bc={u_idx:0,u_snap:1,u_hard:0,tangent:Mt,proxy:Xt,surfaces:br,scaleSurfaces:Mr,spriteRows:nr,surfaceFrame:Wt};if(tr){let J={...bc,u_snap:0,u_materialGridScale:2,spriteGrid:[.5,.5]};if(Ot(st,H.taps,O*2,U*2,{...J,background:co},Et,ct,Ke),Gt.sampleDepth&&Ot(st,Gt.sampleDepth,O*2,U*2,{...J,u_idx:1,surfaceFrame:{...Wt,index:!0,graphDepth:!0}}),Gt.centerMatte){let xe={coverageFilter:tr,background:[1,1,1,1]};Ot(st,Gt.centerMatte,O,U,{...bc,...xe}),Ot(st,Gt.tapMatte,O*2,U*2,{...J,...xe})}}if(Bt?.count){fr??=il(e,{target:P,table:L,program:_,maxSize:k,textureUnit:N,fullscreen:At,cutaway:n?.glsl,spriteLOD:x?.glsl,strandLOD:t.KIT.curveSplats.strandLod.glsl,print:I?.print?.glsl});let J={clip:di,section:Qr,wet:ct,water:Et,env:Ke,layeredGlass:qt,engraving:ma,glass:qt?Fe.textures[0]:void 0,fog:{color:Wt.fog,range:[rr.start??1,rr.max??0]},proxy:mi&&Qi.prepare(Wt,O,U)};if(fr.prepare(Bt),fr.draw(Bt,zt,Ii,ee,J),ne){let xe={...J,cover:ne.plane,layeredGlass:!1,glass:void 0};fr.draw(Bt,ne.buffer,Ii,ee,{...xe,mode:"mask"}),fr.draw(Bt,ne.foreground,Ii,ee,xe)}if(gr&&(gr=fr.anchors(Bt,Ii,ee,{...J,wet:void 0,water:void 0,env:void 0,layeredGlass:!1,glass:void 0},gr)),(pn||Ka)&&(er=fr.owner(Bt,Ii,ee,J)),Gt?.centerMatte&&fr.draw(Bt,Gt.centerMatte,Ii,ee,{...J,filterMatte:!0}),tr){let xe=Gn(t.KIT,a,Fr,ee,O*2,U*2,{...kn,restMarks:void 0,artScale:2});if(xe.count){let Ve={...J,artScale:2,proxy:mi&&Qi.prepare(Wt,O*2,U*2)};fr.prepare(xe),fr.draw(xe,H.taps,Gt.sampleDepth,ee,Ve),Gt.tapMatte&&fr.draw(xe,Gt.tapMatte,Gt.sampleDepth,ee,{...Ve,filterMatte:!0})}}Hr.bind(),Uo.bind(),dt&&(nt||Sr)&&(Xi.bind(9),N(8,Vi))}if(Bt&&typeof h.curveFrame=="function"&&h.curveFrame({segments:Bt.count,tileReferences:Bt.references,peakTile:Bt.peakTile,...Bt.subdivision&&{subdivision:Bt.subdivision},...Bt.strandLod&&{strandLod:Bt.strandLod}}),h[ri]?.(a,er.textures[0],h[ri].depth?er.textures[2]:void 0,ee),Ka){let J=Nc(e,er.framebuffer,O,U,ee.depthRange),xe=h[Qn]??0,Ve=h[Co];h.hybridDepthFrame({view:xe?"portal":Ve?"reflection":"camera",reflection:Ve,portalDepth:xe,width:O,height:U,depth:J})}e.disable(e.BLEND),tr&&H.finish(zt.textures[0],Gt),N(1,tr?H.filtered.textures[0]:zt.textures[0]),N(2,zt.textures[1]),N(5,pi?ji.textures[0]:vr.textures[0]),N(6,pi?ji.textures[1]:vr.textures[1]),N(9,er.textures[0]);let _i=Oe.outline===!0?{}:Oe.outline,uo=pr?.gpu,wc=lt?{u_idxTex:9,u_pixTex:10,u_dat:0,u_depth:2,u_tanF:Mt,u_portho:+ee.ortho,u_asp:ee.aspect,u_pview:ee.view,u_peye:ee.eye,u_fpG:ee.footprint,u_ptime:pt,u_shape:+(h.lightShape!==!1),u_ol:+!!_i,u_olK:_i?.k??2,u_olEps:_i?(_i.eps??.6)/(a.detail||12)/(2*ee.radius):0,u_olGap:_i?(_i.gap??.3)/(2*ee.radius):1,u_patK4:uo.kinds,u_patP:uo.params,u_rmp4:uo.ramps,u_rmpN4:uo.lens,u_detail:a.detail||12}:{};lt&&(As??=_(p.KEY_FS),N(15,null),Sa.bind(),At(As,Ee.framebuffer,O,U,{u_pixOn:1,...wc})),N(15,Ee.textures[0]);let kc=lt&&Pa>0&&h.edges!==!1,Lf=kc&&wf(ee,a,O,U,pt,_i,Et,qr,ct,di,ne?.plane,Ke,_r,Qr),xi=Ze&&Oe.lines,_a=a.outline?.c??0,Tc={};if(Ut){let J=new Float32Array(96),xe=Math.min(24,Ut.gaps?.length??0);if(xe)for(let Ve=0;Ve<xe;Ve++)J.set(Ut.gaps[Ve],Ve*4);Object.assign(Tc,{u_gview:ee.view,u_geye:ee.eye,u_gd:Ut.dir,u_gw:[...Ut.at,Ut.r],u_gcam:[Mt*ee.aspect,Mt,...ee.depthRange],u_gortho:+ee.ortho,u_gtime:mt,u_gc:ql(Ut.cols.map(Ve=>a.pal[Ve]),6),u_gm:+(Ut.mode==="gaps"),u_gq:Ut.steps??0,u_gh:J,u_ghn:xe,u_gfl:Ut.floor??-50})}ea&&(Ca??=_(p.COPY_FS),Kr??=Du(e,{target:P,textureUnit:N,fullscreen:At,copy:Ca}),Kr.buffer.resize(O,U));let Rc=ea?Kr.buffer.framebuffer:$,Ac=fa?$t.framebuffer:Rc;mr&&(cs!==ei.flags?($i.upload(ei.flags),cs=ei.flags):$i.bind(),Fi&&$i.bind(Pt));let lo,fo=lt&&ua,xa=lt&&xr,po=lt&&_r;if(i)lo=Fi?y??=_(Jn(m({protectGaps:!0}).POST_FS)):w;else if(gr||Fi||nt||dt||fo||xa||po||Ke?.media&&lt){let J=nt?Zl:Ql,xe=(ct?1+Number(ct.airPockets)+2*Number(ct.layered)+4*Number(ct.atlas):0)+16*Number(Sr)+32*Number(qt)+64*Number(fo)+128*+!!dt+256*+!!Ke?.media+512*Number(po)+1024*+!!Ke?.lit+2048*+!!xa+4096*Number(Fi)+8192*Number(lt)+16384*Number(Tt)+32768*Number(pi)+65536*+!!gr;J.has(xe)||J.set(xe,_(m({water:!!ct,airPockets:ct?.airPockets,layered:ct?.layered,atlas:ct?.atlas,paletteConstraints:!!dt&&!nt,masked:Sr,contributions:nt,layeredGlass:qt,materialStyles:fo,facingColors:xa&&ki,environment:!!Ke?.media,emitterFog:!!Ke?.lit,relighting:po,protectGaps:Fi,marks:!!gr,patternedResolve:lt,coloredResolve:Tt,paintResolve:pi}).POST_FS)),lo=J.get(xe),dt&&!nt&&(Xi.bind(),N(8,Vi),Sr&&N(7,er.textures[1]))}else lo=ct?ct.post??=_(ct.sources.POST_FS):df(lt||Ut||a.ao||Jr||sr);if(Et&&N(11,(Tt?vr:zt).textures[2]),qt){let J=zt.textures.length-2;N(4,zt.textures[J]),N(7,zt.textures[J+1]),N(8,Fe.textures[0])}xa&&Aa.bind(ls),gr&&(yr.bindRules(),N(25,gr.textures[0]),N(30,gr.textures[1]));let Sc=la?ar.framebuffer:Ac,Ec=Or?ye.source.framebuffer:Sc,Fc=pa?_e.source.framebuffer:Ec;if(At(lo,hr?hr.source.framebuffer:Fc,O,U,{...wc,...Tc,...hf(Jr),...Et,...Ke?.uniforms,u_waterMask:11,...qt&&{u_glassBoundary:8,u_glassBack:4,u_glassThrough:7,u_glassRange:ee.depthRange,u_glassProjection:ee.projection},...dt?{u_constraintSlots:4,u_constraintRows:8,u_constraintDefault:dt.defaultSlot,u_constraintMap:Wi,u_constraintMask:Hi,u_constraintLab:Ki,u_constraintPairs:Yi,u_constraintAnchor:Ea,u_maskOwner:7}:{},...gr&&{...yr.uniforms,u_markWorld:25,u_markRest:30},u_scene:1,u_depth:2,u_crispScene:5,u_crispDepth:6,u_keyTex:15,u_pixOn:+lt,u_keyOn:+lt,u_sprOn:+kc,u_paintOn:pi,...fo&&{u_materialStyles:16},...xa&&{u_facingRows:Lo,u_facingCount:xr.count,u_disabledViewColors:gn,u_facingBones:ls},...po&&{u_relight:wa,u_relightFog:ai(a.pal[rr.c??0]??0),u_relightFogRange:[rr.start??1,rr.max??0]},u_idxTex:9,...Fi&&{u_detailFlags:Pt},u_sprLayer:13,u_markA:+(la||!!Qt),u_pal:qr,u_n:vi,u_luma:0,u_bypass:+(Ie||!!Jt),u_colored:+Tt,u_dither:Dt*.3*(a.dither??1),u_line:ai(a.pal[_a]??0),u_remapLine:Pf&&Number.isInteger(_a)&&_a>=0&&_a<vi?_a+1:0,u_edge:Ze?(a.outline?.edge??0)/(2*ee.radius):0,u_lines:+!!xi,u_lineGap:xi?(xi.gap??.3)/(2*ee.radius):1,u_lineK:xi?xi.k??.55:1,u_lineLit:xi?xi.lit??1.15:1,u_refract:a.refract??6,u_ao:oc,u_aor:(a.ao?.range??.4)/(2*ee.radius),u_gk:Ut?Ut.k||.14:0,u_bars:Math.min(.45,a.anim?.bars??0),u_grade:+!!sr,...sr?{u_out:sr,u_outl:sr}:{}}),hr&&hr.finish(Fc,O,U,qr,sr),pa&&_e.finish(We,(Tt?vr:zt).textures[0],Ec,O,U),Or&&ye.finish(Or,(Tt?vr:zt).textures[0],Sc,O,U),la&&(mr&&$i.bind(),N(8,ar.textures[0]),N(6,Tt?vr.textures[1]:zt.textures[1]),At(F,Ac,O,U,{u_look:8,u_dep:6,u_keep:Oe.clean?.keep??.3,u_scopedOnly:!on,u_hasDetailFlags:mr,u_protectGaps:fc,u_detailOwners:mr?9:8,u_detailFlags:mr?7:8,u_detailWater:mr&&!!Et,u_waterMask:mr&&Et?11:8,u_lineClean:+(h.lineClean!==!1&&!!Oe.pixel)})),fa){Ss??=_(p.DAMP_FS),Ca??=_(p.COPY_FS);let J=(sr??qr).subarray(0,vi*3);lr(Ds,J)||(ht=!1),Ds=J;let xe=1-en,Ve=id(ee.projection,ee.view),wr=Da&&Ve.every((Ct,Ht)=>Math.abs(Ct-Da[Ht])<1e-6);N(8,$t.textures[0]),N(11,$e[en].textures[0]),N(6,zt.textures[1]),At(Ss,$e[xe].framebuffer,O,U,{u_cur:8,u_hist:11,u_dep:6,u_pal:J,u_n:vi,u_have:+(ht&&!!wr),u_iview:ad(ee.view,ee.eye),u_pvp:Da??Ve,u_cam:[Mt,ee.aspect,+ee.ortho,0],u_rng:ee.depthRange}),N(8,$e[xe].textures[0]),At(Ca,Rc,O,U,{u_src:8}),en=xe,ht=!0,Da=Ve}let Sn=[...rc||[],...Cf||[]],vo=[];if(sa){let J;sa.coordinates.size&&(be??=$u(e,r,P,N),J=be(sa.coordinates,er.textures[2],ee.depthRange));let xe=G.resolve(sa,Ve=>J?.get(Ve));vo=xe.pixels,h.protectedPixelsFrame?.(xe.report)}function En(J){!Sn.length&&!vo.length||(Q??=Gu(e,r,N,X.pixels),Q(Sn,O,U,J,er.textures[2],ee.depthRange,vo))}if(ea){let xe=function(){if(!J){let _t=t.KIT.splatFrames.create(a,pt,t.KIT.M);J=Ji.projector(ee,cr=>_t(cr).position())}return J},Ct=function(_t,cr){if(Qt){let{rgb:ho,...Bf}=Ji.apply(_t,cr,Qt,a,Ve);h.colorClustersFrame?.(Bf),ho!==_t.rgb&&(_t={..._t,rgb:ho})}if(!Zr)return _t;let Vr=Ho.apply(_t,cr,Zr,a,{time:mt,captureSites:h.captureBoundarySites});return h.boundaryCelsFrame?.(Vr.report),{..._t,rgb:Vr.rgb}},Ht=function(_t,cr){if(Lr&&h.shotCorrectionSurfaceFrame?.(It.capture(_t,cr,a,xe())),!Br)return _t.rgb;let{edits:Vr,...ho}=It.resolve(_t,cr,Br,a,{time:mt,shotCorrectionFrame:h.shotCorrectionFrame,project:xe()});return h.shotCorrectionsFrame?.(ho),It.apply(_t.rgb,Vr)},J,Ve=Qt?.coherent&&{history:Oa,source:h.colorClusterSource??h.renderHistoryKey??De,time:mt,project:xe(),projection:ee.ortho,reset:h.resetRenderHistory||h.resetColorClusters,captureLabels:h.captureColorClusterLabels,palette:Array.from((sr??qr).subarray(0,vi*3))},wr=Qt&&(la?ar:fa?$t:Kr.buffer);if(li&&(Sn.length||vo.length)){let _t=Kr.buffer;Tr&&(Ma??=P(),Ma.resize(O,U),Kr.finish(er,wr,Ma.framebuffer,O,U,(cr,Vr)=>Ct(cr,Vr).rgb),_t=Ma),En(_t.framebuffer),Kr.finish(er,null,$,O,U,Ht,{source:_t,depthRange:ee.depthRange})}else Kr.finish(er,wr,$,O,U,(_t,cr)=>{let Vr=Ct(_t,cr);return li?Ht(Vr,cr):Vr.rgb},{depthRange:li?ee.depthRange:void 0}),En($)}else En($);return e.activeTexture(e.TEXTURE0),Dr=sc,La=Lt,Zo=a.data,Ps=!!Jt,Ti=!!Ur,Qo=a.count,zs=$,Ms=ei,Bs=ra,vt=dr,oe=h.time,re||(h[To]?.(ee),h[Oi]?.(a,zt.textures[1],ee)),Lf},Rf=function(a,h,O){if(!a){N(4,O);return}let{width:U,height:$,data:ce}=a;if(U>k||$>k)throw new RangeError("Portal aperture exceeds the WebGL texture size limit");e.activeTexture(e.TEXTURE4);let ue=ft[h]??={texture:r.texture()};if(N(4,ue.texture),ue.mask===a)return;let ne=e.getParameter(e.UNPACK_ALIGNMENT);e.pixelStorei(e.UNPACK_ALIGNMENT,1),e.texImage2D(e.TEXTURE_2D,0,e.R8,U,$,0,e.RED,e.UNSIGNED_BYTE,Uint8Array.from(ce)),e.pixelStorei(e.UNPACK_ALIGNMENT,ne),ue.mask=a},Ba=function(a,h,O,U,$,ce,ue=Qe,ne=0,re=!1,Le){let Te=ne<Hl?h.portal:void 0,De=ne===0?h.fade??0:0;if(!Te&&!De)return tn(a,h,O,U,$,ce,ue,void 0,re,Le);ce??=Xr(a,h,O,U);let Be=Te?.opening,Ue=Be&&Xl(Vl(Be.from),ce),ee=Ue&&(ce.ortho?Ue[2]>1e-7:Ue[3]>1e-6);if(!ee&&!De)return tn(a,h,O,U,$,ce,ue,void 0,re,Le);if(O>k||U>k||O>jt[0]||U>jt[1])throw new RangeError("Ink Studio frame exceeds the WebGL viewport or texture size limit");$||(e.canvas.width!==O&&(e.canvas.width=O),e.canvas.height!==U&&(e.canvas.height=U));let je=re?Zt:Yt,qe=je.source??=P();qe.resize(O,U);let Ne;if(ee){Ne=je.destinations[ne]??=P(),Ne.resize(O,U),je.mask??=P(),je.foreground??=P(2),je.mask.resize(O,U),je.foreground.resize(O,U);let Yr=au(ce,Be.camera(Cr(ce)),re),{raw:si,outline:Ir,dither:Ri,scale:ci,clean:Qt,lineClean:ui,colored:Zr,tone:Ai,edges:St,water:Lr,time:It,skyTime:Br,cameraTime:Tr,stepAnimation:li,artDirection:ea,renderStages:Oa,strictContract:Si,environment:mt,colorClusters:pt,boundaryCels:Ua,stableTransparency:ta,resetTransparency:fi,stableDetail:ra,stable:Ga,ditherSpace:Rr,engraving:Qr,engravingLight:$a,screenPrint:ja,brushwork:qa,passQuality:Va,silhouetteProtection:Xa,scalePreviews:ia}=h,Ar=Tf[ne]??=Gi(),nt=js(Te.destination,{raw:si,outline:Ir,dither:Ri,scale:ci,clean:Qt,lineClean:ui,colored:Zr,tone:Ai,edges:St,water:Lr,time:It,skyTime:Br,cameraTime:Tr,stepAnimation:li,artDirection:ea,renderStages:Oa,strictContract:Si,environment:mt,colorClusters:pt,boundaryCels:Ua,stableTransparency:ta,resetTransparency:fi,stableDetail:ra,stable:Ga,ditherSpace:Rr,engraving:Qr,engravingLight:$a,screenPrint:ja,brushwork:qa,passQuality:Va,silhouetteProtection:Xa,scalePreviews:ia,atmosphere:h.atmosphere,coverageAware:h.coverageAware,reflections:h.reflections,...Te.destinationFrame,...re&&{water:!1,reflections:!1,[Co]:h[Co]},curveMode:Te.destinationFrame?.curveMode??h.curveMode,curveSplats:Te.destinationFrame?.curveSplats??h.curveSplats,curveSubdivision:Te.destinationFrame?.curveSubdivision??h.curveSubdivision,curveLod:Te.destinationFrame?.curveLod??h.curveLod,hybridDepthFrame:h.hybridDepthFrame,damp:!1,[Qn]:ne+1},Ar);Ba(nt.world,nt.frame,O,U,Ne.framebuffer,Yr,Vl(Be.to),ne+1,re)}let ot=ee?{buffer:je.mask,foreground:je.foreground,plane:Ue}:void 0,We=tn(a,ee?{...h,damp:!1}:h,O,U,qe.framebuffer,ce,ue,ot,re,Le),Ie=ot?.environment,Ze=+!!Ie?.media+2*!!Ie?.lit;et.has(Ze)||et.set(Ze,_(Rl(Ie?.media,Ie?.lit)));let Dt=et.get(Ze),kt=qe.textures[0],Oe=ee?Be.mask:void 0;N(0,kt),N(1,Ne?.textures[0]??kt),N(2,ee?je.mask.textures[0]:kt),N(5,ee?je.foreground.textures[0]:kt),N(3,We||kt),Rf(Oe,ne,kt),At(Dt,$,O,U,{...Ie?.uniforms,u_source:0,u_destination:1,u_cover:2,u_foreground:5,u_spriteCover:3,u_hasSpriteCover:+!!We,u_aperture:4,u_painted:+!!Oe,u_entryPlane:ue,u_opening:ee?Be.shape==="ellipse"?2:1:0,u_size:[O,U],u_fade:De,...ee?{u_origin:Be.from.origin,u_right:Be.from.right,u_up:Be.from.up,u_normal:Be.from.normal,u_half:[Be.halfWidth,Be.halfHeight],u_eye:ce.eye,u_portalView:ce.view,u_far:ce.clipFar,u_settings:[ce.tangent*ce.aspect,ce.tangent,+ce.ortho]}:{}}),e.activeTexture(e.TEXTURE0)},rn=function(a,h,O,U,$){let ce=h.composite??a.look?.composite;if(ce===void 0||ce===!1)return Ba(a,h,O,U,$);let ue=t.KIT?.frameComposite;if(!ue)throw new Error("Mixed-resolution frames need the Ink Studio KIT");let ne=ue.prepare(ce,O,U,a.look?.pixelSize??1);if([ne,ne.world].some(({w:Be,h:Ue})=>Be>Math.min(k,jt[0])||Ue>Math.min(k,jt[1]))||ne.layers.some(({w:Be,h:Ue})=>Be>k||Ue>k))throw new RangeError("Composite frame exceeds the WebGL viewport or texture size limit");let re=h.interfaceTime??h.time??a.lookSnapshot?.time??0,Le,Te=ne.needsCamera?{...h,...Ro(h,Be=>{Le=Be})}:h,De=ne.needsCamera?()=>ue.layers(ne,a,re,Le,e,h.time):ue.layers(ne,a,re,void 0,e,h.time);qs??=al(e,{program:_,resources:r,target:P,textureUnit:N,fullscreen:At}),qs(a,Te,ne,De,$,Ba)},an=function(a,h,O,U,$){let ce=h.renderGrid??a.look?.renderGrid;if(ce===void 0||ce===!1)return Xs(a,h,O,U,$);let ue=t.KIT?.renderGrid;if(!ue)throw new Error("Tessellated grids need the Ink Studio KIT");let ne=ue.prepare(ce);if(ue.dimensions(ne,O,U),O>Math.min(k,jt[0])||U>Math.min(k,jt[1]))throw new RangeError("Render grid exceeds the WebGL viewport or texture size limit");Vs??=Iu(e,{api:ue,program:_,target:P,textureUnit:N,fullscreen:At}),Vs(a,h,ne,O,U,$,Xs)},Xs=function(a,h,O,U,$){let ce=h.renderGraph??a.look?.renderGraph,ue=h.renderGraphCapture;if((ce===!1||ce===void 0)&&ue===void 0)return Na?.reset(),rn(a,h,O,U,$);let ne=t.KIT?.renderGraph;if(!ne)throw new Error("Render graphs need the Ink Studio KIT");let re=ne.prepare(ce,ue);if(!re||!re.passes.length&&!re.captures.size)return Na?.reset(),rn(a,h,O,U,$);if(O>Math.min(k,jt[0])||U>Math.min(k,jt[1]))throw new RangeError("Render graph exceeds the WebGL viewport or texture size limit");Na??=ul(e,{api:ne,program:_,resources:r,target:P,textureUnit:N,fullscreen:At,maxSize:k}),Na(a,h,re,O,U,$,rn)},Af=function(a,h,O,U,$){h=bt?.options(a,h,t.KIT.timeDomains?.frame)??{...h,time:h.time??h.t};let ce=h.renderHistoryKey??a;({world:a,frame:h}=js(a,h,kf)),ce!==a&&(h={...h,renderHistoryKey:ce});let ue=t.KIT?.presentationTimeline?.sample(a,h.interfaceTime??h.time??a.lookSnapshot?.time??0,h);ue&&(h={...h,...ue});let ne=h.inspection??a.look?.inspection;if(ne===void 0||ne===!1)return an(a,h,O,U,$);let re=t.KIT?.inspection;if(!re)throw new Error("Target inspection needs the Ink Studio KIT");let Le=re.prepare(ne);if(!Le.targets.length)return an(a,h,O,U,$);Ws??=ju(e,{api:re,program:_,resources:r,target:P,textureUnit:N,fullscreen:At,maxSize:k,viewportLimit:jt}),Ws(a,h,Le,O,U,$,an)},m=a=>gl(t.PixelLook,{packedTone:!0,...a}),p=m(),_=a=>r.program(p.POST_VS,a),w=i?_(Jn(p.POST_FS)):void 0,y,F=_(p.CLEAN_FS),T=t.ArtDirection??t.KIT?.artDirection,f=t.KIT?.splatFootprints,x=t.KIT?.sprite?.reconstruction,E=28,R=29,C,V,q,g,b,z,v,A,I=t.KIT?.engraving,ae=t.ArtStability??t.KIT?.artStability,W=t.KIT?.procedural?.airflow,Z=t.KIT?.environmentFrame;u=bl(e,{specialize:!1,sampleCoverage:c,coverageRules:l,stableDetail:d,cutaway:n?.glsl,airflow:W,footprintGLSL:f?.glsl,screenPrintGLSL:I?.print?.glsl,spriteReconstructionGLSL:x?.glsl});let S=r.allocate("VertexArray"),k=e.getParameter(e.MAX_TEXTURE_SIZE),M=e.getParameter(e.MAX_DRAW_BUFFERS),K=go(e,r),{target:P,table:L,textureUnit:N}=K,H,pe,de,ye,Y,D,_e,Se,Ae,B=Oc(e,r,31,k),ie=Tl(e,r,K,k,t),se=Uu(e,r,K,k,t),ve=t.KIT?.highlightCels,j=t.KIT?.shoreFoam,X=t.KIT?.nativeCelPixels,G=t.KIT?.protectedPixels,Q,be,ge=Lu(e,r,K,k,t),le=new Map,Re=P(2),Pe=P(2),Ce=P(),Ee=P(1,{integer:!0}),ke=new Map,he,te,ze,me,fe,Me,we,Fe,He,it,rt,et=new Map,Yt={destinations:[]},Zt={destinations:[]},ft=[],vt,oe,Xe,tt=0,Ye=0,Ge,Rt,xt,yt,wt,ut,Wr,wi,ar=P(),$t=P(),$e=[P(),P()],Je=t.DetailBudgets??t.KIT?.detailBudgets,Pt=26,gt=t.KIT?.passQuality,bt=t.KIT?.renderContract,at=t.KIT?.splatRelighting,Po=t.KIT?.shotLighting,wa=21,Do=new Map,es,ts,rs,is,Io=22,as,ka,os,ns=new WeakMap,ss=new WeakMap,$i,cs,Ta,us,Lo=24,Bo=new WeakMap,ls=Io,No=t.SurfaceLook??t.KIT?.surface,ki=No?.facingColors,Oo,fs,ji,qi,Ra,Hr=L(2048,0,k),Aa=L(768,4,k),Uo=L(1536,7,k),Sa=L(2048,10,k),Yl=r.texture(),Vi,Xi,ps,ds,vs,hs,ms,Wi,Hi,Ki,Yi,Ea,Zl=new Map,Ql=new Map,_s,Go,$o,xs,ys,Zi,jo=new WeakMap,gs=new WeakSet,Jl=0,ef=ou(),qo=t.KIT?.procedural?.splatOrder,Fa=t.KIT?.afterimages,Vo=[],bs=[],oi=new Map,tf={cache:new Map,program:r.program},Xo=[],Qi,fr,ws=!1,Wo,rf,af,za,ks,Ts,Kr,Ma,Ji=t.KIT?.colorClusters,Ho=t.KIT?.boundaryCels,of=[],sf,Rs=!1,As,Ss,Ca,Es,cf,Fs,Ko,Yo,Dr,Zo,Qo,zs,Ms,Cs,Ps,Ti,Jo,pr,Pa=0,ni=rd,en=0,ht=!1,Da,Ds,Is,Ls,Bs,Ns,Os,Us,Ft,Gs,Ia,La,kf=Gi(),Tf=[],jt=e.getParameter(e.MAX_VIEWPORT_DIMS),qs,Vs,Na,Ws;return{render:Af,dispose(){for(let a of bs)a?.dispose();for(let a of oi.values())a.dispose();Qi?.dispose(),q?.dispose();for(let a of Vo)a?.dispose();Wo?.dispose(),u.dispose(),r.dispose()}}}catch(m){throw u?.dispose(),r.dispose(),m}}function Ov(e,{toolkit:t,specialize:o=!0,reuseOrder:s=!0,resolve:i="auto",contextAttributes:r,input:c}={}){if(typeof e?.getContext!="function")throw new TypeError("Ink Studio needs a canvas or OffscreenCanvas");if(typeof t?.PixelLook?.glsl!="string")throw new TypeError("Pass the Ink Studio toolkit, including PixelLook, to createRenderer");if(i!=="auto"&&i!=="simple")throw new RangeError("Ink Studio WebGL resolve must be 'auto' or 'simple'");let l=e.getContext("webgl2",{...r,alpha:!1,antialias:!1,depth:!1,stencil:!1});if(!l)throw new Error("Ink Studio GPU rendering requires WebGL 2");let d={specialize:o,reuseOrder:s,simpleOnly:i==="simple"},n=Wl(l,t,d),u;if(c!==void 0&&c!==!1)try{u=$l(e,{...c,toolkit:t})}catch(f){throw n.dispose(),f}let m=!1,p,_=new WeakMap,w=Gi(),y=f=>{f.preventDefault(),n=null};e.addEventListener?.("webglcontextlost",y);function F(f,x){if(!(f?.data instanceof Float32Array)||!Number.isSafeInteger(f.count)||f.count<0||f.count*16>f.data.length||!f.pal?.length)throw new TypeError("Render expects a world with packed splats, a count, and a palette");if(f.fine&&f.fine.length<f.count*12||f.pix&&f.pix.length<f.count*8)throw new RangeError("Ink Studio material data is shorter than the splat count");if(f.materialPixelStyles!=null&&(!(f.materialPixelStyles instanceof Float32Array)||f.materialPixelStyles.length<f.count*4))throw new RangeError("Ink Studio material pixel styles must cover the splat count");if(f.opticalSplats!=null&&(!(f.opticalSplats instanceof Float32Array)||f.opticalSplats.length!==f.count*12))throw new RangeError("Ink Studio optical materials must match the splat count");let E=x.instances===void 0?null:Pr(x.instances);E&&Ml(f.count,E);let R=f.count+(E?.count??0);if(x.order!==void 0&&(!(x.order instanceof Int32Array)||x.order.length!==R||x.order.some(C=>C<0||C>=R)))throw new TypeError("Draw order must contain valid Int32 splat indices");for(let[C,V]of[["changedRows",512],["changedFineRows",512],["changedPatternRows",1024]]){let q=x[C];if(q!==void 0&&(!Array.isArray(q)||q.some(g=>!Number.isInteger(g)||g<0||g>=Math.max(1,Math.ceil(f.count/V)))))throw new RangeError(C+" must contain valid "+V+"-splat row indices")}if(![x.time??x.t??0,x.bornAt??0,x.scale??1,x.dither??.35].every(Number.isFinite))throw new RangeError("Ink Studio frame parameters must be finite")}let T={...u&&{input:u},describeFrame(f,x={}){let E=t.KIT?.renderContract;if(!E)throw new Error("Frame descriptions need the Ink Studio KIT");return E.describe(f,{...x,width:x.width??x.w??x.target?.width??e.width,height:x.height??x.h??x.target?.height??e.height},t.KIT.timeDomains?.frame)},cameraPose(f,x={}){return Cr(Xr(f,x,x.width??x.w??x.target?.width??e.width,x.height??x.h??x.target?.height??e.height))},renderStream(f,x,{place:E,portals:R=[],selected:C,assemble:V,...q}={}){if(m)throw new Error("The Ink Studio renderer has been disposed");if(typeof f?.advance!="function"||typeof V!="function")throw new TypeError("Stream rendering needs a scene stream and a world assembler");let g=q.width??q.w??q.target?.width??e.width,b=q.height??q.h??q.target?.height??e.height,{snapshot:z,camera:v}=iu(x,q,g,b),A=f.advance({place:E,camera:v,portals:R,selected:C,portalLimit:1}),I=_.get(f),ae=new Map;function W({id:M,place:K,entries:P}){let L=I?.assemble===V&&I.worlds.get(M),H=L?.place===K&&P.length===L.entries.length&&P.every((pe,de)=>{let ye=L.entries[de];return ye.key===pe.key&&ye.revision===pe.revision&&ye.value===pe.value})?L.world:V(K,P);if(H?.count>P.reduce((pe,de)=>pe+de.splats,0))throw new RangeError("Assembled scene exceeds its packed splat budget");return ae.set(M,{place:K,entries:P,world:H}),H}let Z=W(A.views[0]),S=A.views[1],k=S?.entries.length?{opening:S.opening,destination:W(S)}:void 0;return T.render(Z,{...q,cameraSnapshot:z,portal:k}),_.set(f,{assemble:V,worlds:ae}),{world:Z,portal:k,scene:A}},render(f,x={}){if(m)throw new Error("The Ink Studio renderer has been disposed");if(l.isContextLost())throw new Error("The Ink Studio WebGL context is lost");F(f,x);let E=x.portal,R=f;for(let v=0;E&&v<Hl;v++){let{source:A,destination:I,opening:ae,destinationFrame:W={}}=E;if(A&&A!==R||typeof ae?.camera!="function"||!ae.from||!ae.to)throw new TypeError("Expected an oriented portal view for the rendered world");F(I,W),R=I,E=W.portal}if(x.fade!==void 0&&(!Number.isFinite(x.fade)||x.fade<0||x.fade>1))throw new RangeError("Scene fade opacity must be in [0, 1]");let C=Array.isArray(x.target)||ArrayBuffer.isView(x.target)?void 0:x.target,V=x.width??x.w??C?.width??e.width,q=x.height??x.h??C?.height??e.height,g=C?.framebuffer??null;if(C&&(V!==C.width||q!==C.height||!g||!l.isFramebuffer(g)))throw new TypeError("Draw target must match the frame size and use the renderer WebGL context");if(!Number.isSafeInteger(V)||!Number.isSafeInteger(q)||V<1||q<1)throw new RangeError("Ink Studio frame width and height must be positive integers");n??=Wl(l,t,d);let b,z=x.renderGraphCapture===void 0?x:{...x,[$n]:v=>{b=v}};return n.render(f,z,V,q,g),p?.world===f&&(x.changedRows?.length!==0||f.anim?.bones?.length)&&(p=void 0),b},captureTurntable(f,x){if(m)throw new Error("The Ink Studio renderer has been disposed");if(l.isContextLost())throw new Error("The Ink Studio WebGL context is lost");return vu(l,T.render,f,x)},pick(f,x,E={}){if(m)throw new Error("The Ink Studio renderer has been disposed");F(f,E);let R=t.KIT?.procedural?.contributions?.create;if(!R)throw new Error("Contribution picking needs the Ink Studio KIT");let C=t.KIT?.viewPoses;if(E.viewPoses!==!1&&C?.forWorld(f)?.active){let P=Xr(f,E,E.width??E.target?.width??e.width,E.height??E.target?.height??e.height);f=C.frame(f,{...Cr(P),ortho:P.ortho})}let V=E.instances,q=V&&Pr(V).revision,g=E.time??E.t??f.lookSnapshot?.time??0,b=E.sampleWithdrawal??f.sampleWithdrawal??0,z=E.splatCoverage??f.look?.splatCoverage,v=f.materialPixelStyles,A=(E.splatFootprints??f.look?.splatFootprints)!==!1,I=f.dataMarks?.snapshot(),ae=E.reconstruction??f.look?.reconstruction,W=ae===void 0||ae===!1?void 0:JSON.stringify(ae);if(p?.world!==f||p.data!==f.data||p.count!==f.count||p.opticalSplats!==f.opticalSplats||p.group!==V||p.revision!==q||p.withdrawal!==b||p.footprintEnabled!==A||p.footprints!==f.splatFootprints||p.splatCoverage!==z||p.materialStyles!==v||p.marks!==I||p.reconstruction!==W||p.time!==g&&(W!==void 0||f.moving?.length||f.grow||f.anim?.bones)){let P=V?w(f,V,E.changedRows).world:f;W!==void 0&&(P=Kl(t,P,E,ae));let L=R(P,{time:g,sampleWithdrawal:b,splatCoverage:z,cutaway:!1,splatFootprints:A});p={world:f,data:f.data,count:f.count,opticalSplats:f.opticalSplats,group:V,revision:q,time:g,withdrawal:b,reconstruction:W,splatCoverage:z,materialStyles:v,marks:I,footprints:f.splatFootprints,footprintEnabled:A,picker:L}}let Z=t.KIT.cutaway?.prepare(x?.cutaway??E.cutaway??f.look?.cutaway),S=x?.camera;if(Z?.range&&!S){let P=Xr(f,E,E.width??E.target?.width??e.width,E.height??E.target?.height??e.height);S={...Cr(P),setback:P.setback}}let k=x?.footprintView;if(A&&!k&&(f.splatFootprints||V&&Pr(V).hasSplatFootprints)){let P=E.width??E.target?.width??e.width,L=E.height??E.target?.height??e.height;k={...Xr(f,E,P,L),width:P,height:L,variance:E.raw?.3:.15,snap:!E.raw&&!E.colored}}let M=t.KIT?.sprite?.reconstruction,K={water:E.water!==!1,...x,meshes:E.meshes!==!1&&x?.meshes!==!1,brickMeshes:E.brickMeshes!==!1&&x?.brickMeshes!==!1,cutaway:Z,camera:S,footprintView:k};if(f.spriteReconstruction&&M){let P=E.width??E.target?.width??e.width,L=E.height??E.target?.height??e.height,N=Xr(f,E,P,L),{eye:H,back:pe}=Cr(N),de=M.resolve(f,{eye:H,back:pe,ortho:N.ortho,focal:N.projection[5]*L*.5,setback:N.setback,time:g,mode:E.spriteReconstruction});if(de?.mask){let{projection:ye,view:Y}=N,D=([B,ie,se])=>-(Y[2]*B+Y[6]*ie+Y[10]*se+Y[14]),_e=([B,ie,se])=>{let ve=N.ortho?1:D([B,ie,se]);return ve<=0?null:[(Y[0]*B+Y[4]*ie+Y[8]*se+Y[12])*ye[0]/ve*P*.5+P*.5,(Y[1]*B+Y[5]*ie+Y[9]*se+Y[13])*ye[5]/ve*L*.5+L*.5]},Se=B=>D(B)>=N.clipNear&&(!Z||t.KIT.cutaway.margin(Z,...B,D(B)-N.setback)>=0),Ae=x?.accept;K.accept=B=>{let ie=B.kind==="mesh"?de.mask.meshCodes.get(B.mesh):de.mask.codes[B.index],se=ie&&_e(B.point);return(!ie||se&&M.geometry(ie,...se))&&(!Ae||Ae(B))},K.extraHits=B=>M.hits(de,{...B,pixelAt:_e,clip:Se})}}return p.picker.ray(K)},dispose(){if(!m){m=!0,_=new WeakMap;try{u?.dispose()}finally{n?.dispose(),e.removeEventListener?.("webglcontextlost",y)}}}};return T}export{Ov as createRenderer};
