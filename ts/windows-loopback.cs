// WASAPI loopback capture helper for stdinman.
// Compiled at runtime by Windows PowerShell's Add-Type, so it must stay C# 5 compatible.
//   List():          writes "<friendly name>\t<endpoint id>\t<default|>" per active render endpoint to stdout.
//   Capture(device): writes a streaming WAV (mix format, unknown length) of what the endpoint plays to stdout.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Stdinman
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject
    {
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        void RegisterEndpointNotificationCallback(IntPtr client);
        void UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out int count);
        void Item(int index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        void OpenPropertyStore(int access, out IPropertyStore properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out int count);
        void GetAt(int index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;
    }

    // PROPVARIANT is 16 bytes on x86 and 24 bytes on x64; the padding field covers both.
    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant
    {
        [FieldOffset(0)] public short ValueType;
        [FieldOffset(8)] public IntPtr Pointer;
        [FieldOffset(16)] public IntPtr Padding;
    }

    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out int frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        void GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
        void ReleaseBuffer(int frames);
        void GetNextPacketSize(out int frames);
    }

    public static class Loopback
    {
        const int RenderFlow = 0;
        const int ConsoleRole = 0;
        const int DeviceStateActive = 1;
        const int ClsCtxAll = 23;
        const int ShareModeShared = 0;
        const int StreamFlagsLoopback = 0x00020000;
        const int BufferFlagsSilent = 0x2;
        const long HundredNanosecondsPerMillisecond = 10000;
        const short VtLpwstr = 31;

        static readonly Guid AudioClientId = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        static readonly Guid AudioCaptureClientId = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
        static readonly Guid FriendlyNameFormatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant value);

        [DllImport("ole32.dll")]
        static extern void CoTaskMemFree(IntPtr memory);

        static IMMDeviceEnumerator CreateEnumerator()
        {
            return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        }

        static string GetId(IMMDevice device)
        {
            string id;
            device.GetId(out id);
            return id;
        }

        static string GetFriendlyName(IMMDevice device)
        {
            IPropertyStore store;
            device.OpenPropertyStore(0, out store);
            PropertyKey key = new PropertyKey();
            key.FormatId = FriendlyNameFormatId;
            key.PropertyId = 14;
            PropVariant value;
            store.GetValue(ref key, out value);
            string name = value.ValueType == VtLpwstr ? Marshal.PtrToStringUni(value.Pointer) : "";
            PropVariantClear(ref value);
            return name ?? "";
        }

        static string GetDefaultRenderId(IMMDeviceEnumerator enumerator)
        {
            try
            {
                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(RenderFlow, ConsoleRole, out device);
                return GetId(device);
            }
            catch (COMException)
            {
                return "";
            }
        }

        static IMMDevice FindDevice(IMMDeviceEnumerator enumerator, string query)
        {
            IMMDevice device;
            if (String.IsNullOrEmpty(query))
            {
                enumerator.GetDefaultAudioEndpoint(RenderFlow, ConsoleRole, out device);
                return device;
            }

            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(RenderFlow, DeviceStateActive, out devices);
            int count;
            devices.GetCount(out count);

            IMMDevice partialMatch = null;
            int partialMatches = 0;
            for (int i = 0; i < count; i++)
            {
                devices.Item(i, out device);
                string name = GetFriendlyName(device);
                if (String.Equals(name, query, StringComparison.OrdinalIgnoreCase) || GetId(device) == query)
                {
                    return device;
                }

                if (name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    partialMatch = device;
                    partialMatches++;
                }
            }

            if (partialMatches == 1)
            {
                return partialMatch;
            }

            throw new ArgumentException(partialMatches > 1
                ? "audio device \"" + query + "\" matches more than one output device"
                : "audio device \"" + query + "\" was not found among the active output devices");
        }

        public static int List()
        {
            IMMDeviceEnumerator enumerator = CreateEnumerator();
            string defaultId = GetDefaultRenderId(enumerator);
            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(RenderFlow, DeviceStateActive, out devices);
            int count;
            devices.GetCount(out count);

            StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            for (int i = 0; i < count; i++)
            {
                IMMDevice device;
                devices.Item(i, out device);
                string id = GetId(device);
                writer.Write(GetFriendlyName(device) + "\t" + id + "\t" + (id == defaultId ? "default" : "") + "\n");
            }

            writer.Flush();
            return 0;
        }

        static void WriteWavHeader(Stream output, byte[] format)
        {
            BinaryWriter writer = new BinaryWriter(output);
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(UInt32.MaxValue);
            writer.Write(Encoding.ASCII.GetBytes("WAVE"));
            writer.Write(Encoding.ASCII.GetBytes("fmt "));
            writer.Write(format.Length);
            writer.Write(format);
            if (format.Length % 2 == 1)
            {
                writer.Write((byte)0);
            }

            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(UInt32.MaxValue);
            writer.Flush();
        }

        public static int Capture(string query)
        {
            IMMDeviceEnumerator enumerator = CreateEnumerator();
            IMMDevice device = FindDevice(enumerator, query);
            Console.Error.WriteLine("capturing \"" + GetFriendlyName(device) + "\"");

            Guid audioClientId = AudioClientId;
            object instance;
            device.Activate(ref audioClientId, ClsCtxAll, IntPtr.Zero, out instance);
            IAudioClient client = (IAudioClient)instance;

            IntPtr mixFormat;
            client.GetMixFormat(out mixFormat);
            int blockAlign = Marshal.ReadInt16(mixFormat, 12);
            int formatLength = 18 + Marshal.ReadInt16(mixFormat, 16);
            byte[] format = new byte[formatLength];
            Marshal.Copy(mixFormat, format, 0, formatLength);
            client.Initialize(ShareModeShared, StreamFlagsLoopback, 100 * HundredNanosecondsPerMillisecond, 0, mixFormat, IntPtr.Zero);
            CoTaskMemFree(mixFormat);

            Guid captureClientId = AudioCaptureClientId;
            object service;
            client.GetService(ref captureClientId, out service);
            IAudioCaptureClient capture = (IAudioCaptureClient)service;

            Stream output = Console.OpenStandardOutput();
            WriteWavHeader(output, format);
            client.Start();

            byte[] buffer = new byte[0];
            while (true)
            {
                Thread.Sleep(10);
                int packetFrames;
                capture.GetNextPacketSize(out packetFrames);
                while (packetFrames > 0)
                {
                    IntPtr data;
                    int frames;
                    int flags;
                    long devicePosition;
                    long qpcPosition;
                    capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                    int bytes = frames * blockAlign;
                    if (buffer.Length < bytes)
                    {
                        buffer = new byte[bytes];
                    }

                    if ((flags & BufferFlagsSilent) != 0)
                    {
                        Array.Clear(buffer, 0, bytes);
                    }
                    else
                    {
                        Marshal.Copy(data, buffer, 0, bytes);
                    }

                    capture.ReleaseBuffer(frames);
                    output.Write(buffer, 0, bytes);
                    capture.GetNextPacketSize(out packetFrames);
                }

                output.Flush();
            }
        }
    }
}
